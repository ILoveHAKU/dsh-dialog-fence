# dsh-dialog-fence

> 给 DSH（DeepSeek Harness）的每一次对话设定**边界与围栏**：一套按会话隔离、随时增删、下一轮即生效的行为约束规则。
> 不破坏前缀缓存 · 不膨胀上下文 · 不影响其它对话 · 与 billion-context 压缩共存。

适用形态：**`dsh` CLI（web / headless / acp 等 profile）** 与 **DSH Desktop**。

---

## 它解决什么问题

大模型每轮都会忘掉"这次对话的规矩"。常见的补丁方式都有代价：

| 做法 | 代价 |
|---|---|
| 把规矩写进系统提示词 | 内容一变，系统提示词就变 → 前缀缓存整体失效（本机 workbuddy / opencode-go 路由未声明 `systemPromptUpdate: 'in-history'`，会触发 head 重写） |
| 每轮追加一条 user 消息 | 纯追加安全，但永不回收，几十轮后吃掉几千 token |
| 用压缩插件的"规则"功能 | billion-context 0.1.202 的 `acp_rule` 只存不注（源码里 `RULES_USAGE_PROMPT` 有定义零引用），plugin 模式 `compress.rules` 亦不生效 |

dialog-fence 的做法：把规则注入到 **运行时上下文快照（runtime context）** 这一段里。

```
rules.json（按 sessionId 分桶）
   └─ systemPrompt.context({ name:'dialog-fence:rules', order:118 })
        └─ 只在 enabled 的会话返回文本，其它会话返回空串
             └─ agent-loop: joinContextSections() → "Current runtime context. ..."
                  └─ RuntimeContextProjection.project()
                       ├─ 文本与上次相同  → return（一条都不追加，零 token）
                       └─ 文本变化        → 追加一条新 user 消息（纯 append）
```

三件事因此同时成立：

1. **零缓存破坏**：从不碰系统提示词；历史里只有"追加"，没有任何前缀被重写。
2. **零无谓消耗**：文本不变时快照不落盘，同一条规则不会每轮重发。
3. **压缩后仍存活**：快照头是 `Current runtime context`，被 billion-context 的 `dshDurableToolPath` 归为 `durable/runtime-context`，自动进 `protectedLatestTools`（只保护最新一份，旧快照可被压缩），围栏常驻且不膨胀。

隔离性：`rules.json` 以 `sessionId` 为键，未登记的会话渲染空字符串，而 `renderContextSections()` 会 `.filter(s => s.text.length > 0)` —— **空串 = 零 token、零注入、零副作用**。

---

## 安装

两条路都行，选一条即可。改完**必须完全退出并重启 DSH**（宿主半边不走 dsh-hmr 热重载）。

### 方式 A：一键脚本（file:/// 挂载，最简单，无需 npm 发布）

```bash
# 查看环境与安装状态
node scripts/install.mjs status

# 装到默认 profile（本机 DSH Desktop 用的 profile 叫 web）
node scripts/install.mjs install

# 指定 profile / DSH_HOME
node scripts/install.mjs install --profile headless --home "C:\Users\你\AppData\Roaming\dsh-desktop\harness"

# 先看会写什么，不落盘
node scripts/install.mjs install --dry-run

# 卸载（只删插入行，rules.json 保留）
node scripts/install.mjs uninstall
```

脚本做的事：往 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 末尾追加一段带标记的 insert 块，并在改写前自动备份成 `cordis.patch.yml.<时间戳>.bak`。

```yaml
# >>> dsh-dialog-fence (managed by scripts/install.mjs — do not edit by hand) >>>
- insert:
    - id: dialog-fence
      name: "file:///C:/.../dialog-fence/index.js"
# <<< dsh-dialog-fence <<<
```

> 若本机没有 `node`（DSH Desktop 自带的是 Electron），用：
> `$env:ELECTRON_RUN_AS_NODE="1"; & "D:\DSH Desktop\DSH Desktop.exe" scripts\install.mjs status`

### 方式 B：作为 profile bundle 安装（`dsh plugin` / pnpm 生态）

包内已带 `cordis.patch.yml` 与 `dsh.bundle.patch` 声明，因此装进 profile 后由 `dsh-app-boot` 自动应用：

```bash
# 1) 加进 profile 依赖（私有仓库用 git 形式；公开发布后也可用包名）
dsh plugin --profile web add github:ILoveHAKU/dsh-dialog-fence

# 2) 把它列进 profile 的 dsh.profile.bundles（profiles/web/package.json）
#    "dsh": { "profile": { "bundles": [ ... 原有项, "dsh-dialog-fence" ] } }

# 3) 重启 DSH
```

`dsh` 与 `dsh desktop` 的差别只在 profile 名字上：两者读同一套 profile 补丁层。
注意 `desktop` 这个 profile 名由 Electron 独占，CLI 会拒绝 `--profile desktop`（本机 Desktop 实际使用的是 `web`）。

### 验证安装

```bash
# 1) 无宿主单元测试（语法 + 行为，不会碰线上 rules.json）
node test/smoke.mjs && node test/route.mjs && node test/client.mjs

# 2) 重启后在任意会话里
/fence status
```

重启并开启围栏后，下一轮的运行时上下文里会出现：

```
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

...（沙箱策略 / 审批策略）...

Dialog fence (user-set rules binding this conversation; a newer direct user instruction wins on conflict):
1. 你的第一条规则
```

看到这段就说明生效了。

---

## 用法

### 可视化面板（web / DSH Desktop）

重启后，会话右上角的工具区会出现一个 **「围栏」** 按钮，按钮上的数字是当前会话的规则条数（蓝点 = 已启用）。点开即面板：

- 逐条查看 / 编辑 / 删除规则
- 启用 / 停用本会话围栏
- 底部实时显示 `注入 N 字符 ≈ M token`
- 所有改动**下一轮生效**，无需重启

面板只在 Web 形态出现（CLI / TUI / headless 没有 `connection` 服务，插件会自动跳过路由注册，`/fence` 命令照常可用）。

### 斜杠命令（所有形态）

| 命令 | 作用 |
|---|---|
| `/fence` | 查看状态（启用与否、条数、实际注入文本、token 估算） |
| `/fence on` / `/fence off` | 启用 / 停用本会话围栏 |
| `/fence add <规则文本>` | 追加一条规则（自动启用；重复文本不会重复添加） |
| `/fence rm <序号>` | 删除第 N 条 |
| `/fence clear` | 清空本会话规则（保留启用状态） |
| `/fence reset` | 彻底删除本会话记录（等于从未配置过） |
| `/fence help` | 帮助 |

### 直接编辑状态文件

`rules.json`（默认在插件目录下，可用环境变量 `DIALOG_FENCE_RULES` 指到别处）：

```json
{
  "version": 1,
  "sessions": {
    "session-<uuid>": {
      "enabled": true,
      "rules": [
        "不要修改本仓库以外的文件",
        "结论不确定时必须标注出来"
      ]
    }
  }
}
```

要点：

- 键是会话 id（`/fence status` 会打印当前会话 id）。
- **单条 ≤ 400 字符；每会话最多 40 条；渲染上限 2400 字符**（超出会截断并注明 `fence truncated: N/M rules shown`）。
- 规则里**不要写 `{{ }}`**：宿主的 `interpolate()` 遇到未注册变量会抛错。插件已用 `try/catch` 兜底降级为空，但内容会静默失效。
- 文件写入请用 UTF-8。插件对 UTF-8 BOM 与 UTF-16LE 都做了兼容（历史事故：PowerShell 写坏过一次），但别依赖它。

---

## 与 billion-context（主动压缩）的关系

| 场景 | 结果 |
|---|---|
| 围栏消息 | 落在 `Current runtime context` 快照内 → `durable/runtime-context` → 自动进 `protectedLatestTools`：**只保最新一份**，旧快照照常被压缩 |
| 想要全历史硬保护 | 在 `~/.config/billion-context/billion-context.json` 写 `{"compress":{"protectedTools":["durable/*"]}}`，成为 HARD exclusion（永不折叠） |
| 想改回自动模式 | 从 `protectedTools` / `protectedLatestTools` 里删掉 `durable/*`，billion-context 会重新自动追加 `durable/*` 到 `protectedLatestTools` |

推论：**不要发增量 delta，要发累积完整快照**。`protectedLatestTools` 的语义是"同一虚拟路径只保最新一条"，发 delta 会让规则在半途丢失。

---

## 目录结构

```
dialog-fence/
├── index.js            宿主半边：运行时上下文段 + /fence 命令 + HTTP 路由（零 import）
├── client.js           浏览器半边：会话头部按钮 + 浮层面板（懒 CJS 工厂，只 require react）
├── package.json        dsh.bundle.patch / dsh.client 声明
├── cordis.patch.yml    bundle 安装层（方式 B 用）
├── rules.json          规则状态（按 sessionId 分桶，运行时生成）
├── scripts/install.mjs 一键安装器（方式 A 用，同时支持 dsh 与 DSH Desktop）
├── test/               smoke（宿主逻辑）/ route（HTTP API）/ client（bundle 形态）
└── docs/               设计与实施方案、运维手册与变更记录
```

## 文档

- [设计与实施方案](docs/设计与实施方案.md) —— 方案、红线、源码级依据、被否决的替代路线
- [运维手册与变更记录](docs/运维手册与变更记录.md) —— 日常操作、改代码流程、排查手册、事故记录

## 已知限制

- **宿主半边改动必须重启 DSH**，`dsh-hmr` 不重载本插件（已实测）。
- 面板需要 Web 形态；CLI / TUI / headless 只有 `/fence` 命令。
- 规则是"软约束"：它进入模型可见上下文并对模型产生强引导，但**不是强制拦截**。要硬拦截工具调用，请用 `PreToolUse` 钩子（本机已有 `harness/fence/guard.mjs` 做这类事）。
- 与 `workbuddy` / `opencode-go` 等未声明 `systemPromptUpdate` 的路由完全兼容——正因为本插件**从不改系统提示词**。

## License

MIT
