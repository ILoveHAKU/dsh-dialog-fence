# dsh-dialog-fence

> 给 DSH（DeepSeek Harness）的每一次对话设定**边界与围栏**：一套按会话隔离、随时增删、下一轮即生效的行为约束规则。
> 每条规则就是**一个独立的 `.txt` 文件**——用任何编辑器随手改，下一轮生效。
> 不破坏前缀缓存 · 不膨胀上下文 · 不影响其它对话 · 与 billion-context 压缩共存。

适用形态：**`dsh` CLI（web / headless / acp 等 profile）** 与 **DSH Desktop**。

---

## 它解决什么问题

大模型每轮都会忘掉「这次对话的规矩」。常见的补丁方式都有代价：

| 做法 | 代价 |
|---|---|
| 把规矩写进系统提示词 | 内容一变，系统提示词就变 → 前缀缓存整体失效（本机 workbuddy / opencode-go 路由未声明 `systemPromptUpdate: 'in-history'`，会触发 head 重写） |
| 每轮追加一条 user 消息 | 纯追加安全，但永不回收，几十轮后吃掉几千 token |
| 用压缩插件的「规则」功能 | billion-context 0.1.202 的 `acp_rule` 只存不注（源码里 `RULES_USAGE_PROMPT` 有定义零引用），plugin 模式 `compress.rules` 亦不生效 |

dialog-fence 的做法：把规则注入到 **运行时上下文快照（runtime context）** 这一段里。

```
rules/sessions/<会话 id>/01-xxx.txt   ← 每条规则一个文件
rules/state.json                      ← 只存开关（全局 + 各会话），不存正文
   └─ systemPrompt.context({ name:'dialog-fence:rules', order:118 })
        └─ 只在 enabled 的会话返回文本，其它会话返回空串
             └─ agent-loop: joinContextSections() → "Current runtime context. ..."
                  └─ RuntimeContextProjection.project()
                       ├─ 文本与上次相同  → return（一条都不追加，零 token）
                       └─ 文本变化        → 追加一条新 user 消息（纯 append）
```

三件事因此同时成立：

1. **零缓存破坏**：从不碰系统提示词；历史里只有「追加」，没有任何前缀被重写。
2. **零无谓消耗**：文本不变时快照不落盘，同一条规则不会每轮重发。
3. **压缩后仍存活**：快照头是 `Current runtime context`，被 billion-context 的 `dshDurableToolPath` 归为 `durable/runtime-context`，自动进 `protectedLatestTools`（只保护最新一份，旧快照可被压缩），围栏常驻且不膨胀。

隔离性：规则目录以 `sessionId` 为键，未登记的会话渲染空字符串，而 `renderContextSections()` 会 `.filter(s => s.text.length > 0)` —— **空串 = 零 token、零注入、零副作用**。

---

## 五处界面

| 界面 | 位置 | 能力 |
|---|---|---|
| 会话按钮 | 会话右上角工具区「围栏」，带规则条数徽标 | 打开本会话规则浮层 |
| 规则浮层 | 右下角面板 | 逐条查看 / **单行内联编辑**（无 textarea）/ 删除 / 新增 / 启停 / 清空 |
| **设置页** | 设置左栏 → **「对话围栏」**（与「通知提醒」「模型」同级） | **全局总开关** + 所有已配置会话的清单（启用状态、规则条数） |
| **插件详情页配置区** | 左侧「插件」→ **已安装** → **dsh-dialog-fence** → 详情页（包描述与行之间） | 同一份配置界面 |
| 插件页标签页 | 设置 → **内置插件** → 「对话围栏」一页 | 同一份配置界面（老入口，仍在） |

五处界面写的是同一份文件：面板改完 → 文件落盘 → 下一轮装配时重新读取 → 生效。没有任何状态分叉。

> 为什么卡片在「已安装」而不是「官方」：`plugins.item` 槽位的语义被写死为「官方分组里的一张卡片」，
> 改 id / order 都改不到别处；`plugins.bundle.config` 才属于「组合包自己的配置」，
> 以 **npm 包名** 为 key 渲染在该 bundle 详情页的描述与行之间。
> 0.5.0 起本插件按组合包安装（profile `dependencies` + `dsh.profile.bundles` + `dsh.bundle.patch` 三件齐备），
> 因此它出现在「已安装」分组，装与卸都走插件页右上角「添加插件」那套官方流程。

---

## 安装

推荐走**官方插件安装器**（装在「已安装」分组里，可一键卸载）。改完**必须完全退出并重启 DSH**（宿主半边不走 dsh-hmr 热重载）。

### 方式 A：官方安装器（推荐，出现在「已安装」分组）

包内已带 `dsh.bundle.patch: ./cordis.patch.yml`、`exports`、`icon` 与 `dsh.client` 声明，三件套齐备（`dependencies` + `dsh.profile.bundles` + bundle patch），因此官方安装器直接认它。

**图形界面**：左侧「插件」→ 右上角「**添加插件**」→ 在输入框填本包的**绝对路径**：

```
C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\dialog-fence
```

点安装。成功后卡片出现在「**已安装**」分组（不是「官方」分组），点进去的详情页里就有围栏配置区。
卸载同理：进该包详情页点「卸载」，卡片消失、loader 行一并移除。

**命令行**：

```bash
dsh plugin --profile web add "C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\dialog-fence"
```

`dsh plugin add` 装完后，`dsh-plugin-manager` 的 `reconcile()` 会**自动**把声明了 `dsh.bundle` 的新依赖追加进 profile 的 `dsh.profile.bundles` 并保存 manifest —— 不需要手工改 `profiles/<profile>/package.json`。

> ⚠️ **重要：本地路径安装是「复制」，不是「链接」**
>
> DSH Desktop 的安装后端（`profileBundlePackageBackend`）会把整个源码目录**复制**
> 到 generation 快照里，再在那儿 pnpm add：
>
> ```
> harness/profiles/.generations/live/dsh-dialog-fence+<版本>+<hash>/node_modules/dsh-dialog-fence/
> ```
>
> 所以**改完 `harness/dialog-fence/` 里的源码，已安装的那份不会跟着变**，
> 必须在插件页卸载再装一次（或重跑上面那条命令）。
> 规则数据不在这里：默认数据目录固定为 `<DSH_HOME>/dialog-fence/rules`，
> 与 generation 快照无关，升级换代不会丢规则（见下面「直接编辑规则文件」）。

> 想要「改一行就生效」的开发体验，用方式 B。

### 方式 B：`file:///` 挂载（开发用，不进「已安装」清单）

```bash
# 装到默认 profile（本机 DSH Desktop 用的 profile 叫 web）
node scripts/install.mjs install

# 指定 profile / DSH_HOME；--dry-run 只查看不落盘
node scripts/install.mjs install --profile headless --home "C:\Users\你\AppData\Roaming\dsh-desktop\harness" --dry-run

# 卸载（只删插入行，规则文件保留）
node scripts/install.mjs uninstall
```

脚本往 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 末尾追加一段带标记的 insert 块，改写前自动备份成 `cordis.patch.yml.<时间戳>.bak`：

```yaml
# >>> dsh-dialog-fence (managed by scripts/install.mjs — do not edit by hand) >>>
- insert:
    - id: dialog-fence
      name: "file:///C:/.../dialog-fence/index.js"
# <<< dsh-dialog-fence <<<
```

> 若本机没有 `node`（DSH Desktop 自带的是 Electron），用：
> `$env:ELECTRON_RUN_AS_NODE="1"; & "D:\DSH Desktop\DSH Desktop.exe" scripts\install.mjs status`

这种方式是**引用源码目录**，改 `client.js` 刷新页面即可、改 `index.js` 重启即可，无需重装。
代价：`file:///` 插入行不属于 profile bundle，因此

- **不会**出现在插件页「已安装」分组（插件管理清单只列 profile 里真实安装的包）；
- Desktop 日志可能出现 `[desktop] profile inconsistency: the patch layer inserts file:///…, which is not installed`——只是提示，**不影响加载**，同一份日志下一行就是 `[dialog-fence] ready`。

> **两种方式不要同时用**。同时装会有两条 loader 行重复注册槽位。
> 从方式 B 切到方式 A 之前，先 `node scripts/install.mjs uninstall`。

### 验证安装

```bash
# 1) 无宿主测试（语法 + 行为，不会碰线上规则目录）
node test/smoke.mjs && node test/route.mjs && node test/client.mjs && node test/render.mjs

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

重启后：

- **会话右上角**出现「围栏」按钮，数字是当前会话的规则条数（高亮 = 已启用）。点开即浮层。
- 每条规则占一行：左侧序号、中间正文（下面是它对应的文件名）、右侧「改」「删」。
  点「改」把该行就地变成**单行输入框**，`Enter` 保存 / `Esc` 取消 —— **没有任何 textarea**。
- 底部有单行输入框可直接新建一条，另有「清空」，右下角实时显示 `注入 N 字符 ≈ M token`。
- 所有改动**下一轮生效**，无需重启。

**三处配置入口**（渲染的是同一个组件，内容和行为完全一致）：

- **设置左栏 → 「对话围栏」**：一级菜单项，和「通知提醒」「模型」并排。
- **左侧「插件」→ 已安装 → dsh-dialog-fence**：点进该包详情页，配置区在包描述与行之间。
- **设置 → 内置插件 → 「对话围栏」标签页**：老入口，保留。

三处都有：

- **总开关**（关掉后所有会话立即零注入，规则文件原封不动）
- 会话清单表：会话 id / 启用状态 / 规则条数
- 数据目录路径（方便直接去改文件）

面板与这三处配置页都只在 Web 形态出现（CLI / TUI / headless 没有 `connection` 服务，插件会自动跳过路由注册，`/fence` 命令照常可用）。

### 斜杠命令（所有形态）

| 命令 | 作用 |
|---|---|
| `/fence` | 查看状态（启用与否、条数、实际注入文本、token 估算） |
| `/fence on` / `/fence off` | 启用 / 停用本会话围栏 |
| `/fence add <规则文本>` | 追加一条规则（= 新建一个 txt；自动启用；重复文本不会重复添加） |
| `/fence rm <序号>` | 删除第 N 条（= 删除对应 txt） |
| `/fence clear` | 清空本会话规则文件（保留启用状态） |
| `/fence reset` | 彻底删除本会话记录（等于从未配置过） |
| `/fence dir` | 打印本会话规则目录与全局 state.json 路径 |
| `/fence help` | 帮助 |

### 直接编辑规则文件（推荐给「随时配置和维护」）

默认数据目录 `<DSH_HOME>/dialog-fence/rules`（可用环境变量 `DIALOG_FENCE_DIR` 指到别处）：

```
<DSH_HOME>/dialog-fence/rules/
├── state.json                          ← 只存开关，不存正文
└── sessions/
    └── session-<uuid>/
        ├── 01-no-outside-edits.txt     ← 文件名前缀决定注入顺序
        └── 02-flag-uncertainty.txt
```

> 为什么规则不放在包目录里：0.5.0 起本插件可以作为组合包被官方安装器装进
> `profiles/.generations/live/<gen>/node_modules/dsh-dialog-fence/`，那个目录每次升级
> 都会换成一份新的快照副本。宿主半边的 `resolveDshHome()` 会从插件所在目录向上找
> 第一个同时含 `profiles/` 与 `sessions/` 的祖先（即 DSH home），把数据目录固定在那里，
> 于是**开发态（`<home>/dialog-fence`）与组合包快照形态（`<gen>/node_modules/dsh-dialog-fence`）
> 指向同一个 `<home>/dialog-fence/rules`**，换版本不丢规则。

规则就是「目录里有几个 txt，就有几条规则」：

- **往里丢一个 `.txt`** → 该会话自动启用并生效（即使 `state.json` 里没有这个会话）。
- **改文件内容** → 下一轮注入的文本跟着变。
- **删文件** → 规则消失。
- 空白文件不算规则（跳过）。

要点：

- 键是会话 id（`/fence status` 或 `/fence dir` 会打印当前会话 id）。
- **单条 ≤ 2000 字符；每会话最多 40 条；渲染上限 2400 字符**（超出会截断并注明 `fence truncated: N/M rules shown`）。
- 规则里**不要写 `{{ }}`**：宿主的 `interpolate()` 遇到未注册变量会抛错。插件已用 `try/catch` 兜底降级为空，但内容会静默失效。
- 文件写入请用 UTF-8。插件对 UTF-8 BOM 与 UTF-16LE 都做了兼容（历史事故：PowerShell 写坏过一次），但别依赖它。

---

## 与 billion-context（主动压缩）的关系

| 场景 | 结果 |
|---|---|
| 围栏消息 | 落在 `Current runtime context` 快照内 → `durable/runtime-context` → 自动进 `protectedLatestTools`：**只保最新一份**，旧快照照常被压缩 |
| 想要全历史硬保护 | 在 `~/.config/billion-context/billion-context.json` 写 `{"compress":{"protectedTools":["durable/*"]}}`，成为 HARD exclusion（永不折叠） |
| 想改回自动模式 | 从 `protectedTools` / `protectedLatestTools` 里删掉 `durable/*`，billion-context 会重新自动追加 `durable/*` 到 `protectedLatestTools` |

推论：**不要发增量 delta，要发累积完整快照**。`protectedLatestTools` 的语义是「同一虚拟路径只保最新一条」，发 delta 会让规则在半途丢失。

---

## 目录结构

```
dialog-fence/
├── index.js            宿主半边：运行时上下文段 + /fence 命令 + HTTP 路由（零 import）
├── client.js           浏览器半边：会话按钮 + 浮层面板 + 设置页/插件详情配置区/插件标签页（懒 CJS 工厂，只 require react）
├── icon.svg            插件页图标
├── package.json        dsh.bundle.patch / dsh.client / icon 声明
├── cordis.patch.yml    bundle 安装层（方式 A 用）
├── rules/              开发态遗留的规则目录（0.5.0 起数据在 <DSH_HOME>/dialog-fence/rules，已在 .gitignore 中）
├── scripts/install.mjs 一键安装器（方式 B 用，同时支持 dsh 与 DSH Desktop）
├── test/               smoke（宿主逻辑）/ route（HTTP API）/ client（bundle 形态）/ render（真 React 首帧）
└── docs/               设计与实施方案、运维手册与变更记录
```

## 文档

- [设计与实施方案](docs/设计与实施方案.md) —— 方案、红线、源码级依据、被否决的替代路线
- [运维手册与变更记录](docs/运维手册与变更记录.md) —— 日常操作、改代码流程、排查手册、事故记录

## 已知限制

- **宿主半边改动必须重启 DSH**，`dsh-hmr` 不重载本插件（已实测）。
- 面板与三处配置入口需要 Web 形态；CLI / TUI / headless 只有 `/fence` 命令。
- 规则是「软约束」：它进入模型可见上下文并对模型产生强引导，但**不是强制拦截**。要硬拦截工具调用，请用 `PreToolUse` 钩子（本机已有 `harness/fence/guard.mjs` 做这类事）。
- 与 `workbuddy` / `opencode-go` 等未声明 `systemPromptUpdate` 的路由完全兼容——正因为本插件**从不改系统提示词**。
- 总开关控制的是「是否注入」，不等于卸载插件；要彻底停用请在插件页该包详情页里关掉开关或直接卸载。
- 本地路径安装是**复制**进 generation 快照，改源码后必须重装（见「安装」一节的警告）。

## License

MIT
