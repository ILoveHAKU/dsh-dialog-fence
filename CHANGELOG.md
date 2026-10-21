# 变更记录（CHANGELOG）

本文件按版本记录**用户可见的**改动。逐条的设计理由、源码级依据、被否决的替代路线写在
[`docs/设计与实施方案.md`](docs/设计与实施方案.md)，踩过的坑与排查步骤写在
[`docs/运维手册与变更记录.md`](docs/运维手册与变更记录.md)。

版本号从 `0.2.0` 起打 tag；`0.1.0` 是首次落地，从未单独提交过。

---

## 0.9.1 — 开源前整理

**这一版没有功能改动**，全部是「把它放到公开仓库上之前必须做的事」。

### 新增

- `test/opensource.mjs`：泄漏扫描器，6 条规则（真实姓名 / 姓-IT 形态 / hostname / 内部对话编号 / 真实 session id / 绝对用户路径），**文件与 commit message 都扫**，并顺带验证 `.gitignore` 真的挡住了 `fence.json` 与 `rules/`。已并入 `npm test`，另有 `npm run test:opensource` 单独跑。
- `.github/workflows/test.yml`：在 ubuntu + node 22 上跑 `npm test`。**没有它，GitHub 的「Require status checks」选不到任何 job，PR 会永久卡在 pending。**
- `.github/workflows/triage.yml`：只读元数据地自动关闭「正文过短 / 标题只有一条链接 / （可选）新注册账号」的 issue 与 PR，**绝不 checkout PR 代码**。
- `.github/pull_request_template.md`、`.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`、`.github/SECURITY.md`。
- `CHANGELOG.md`（本文件）。
- `package.json` 补 `homepage` / `bugs`；`engines.node` 由 `>=20` 收紧为 **`>=20.16.0`**（宿主半边依赖 `process.getBuiltinModule`，该 API 由 v20.16.0 / v22.3.0 引入）。

### 变更

- **重写 git 历史**，清掉本机用户名。原来散布在 10 个 commit 的 blob 里，共 53 处绝对用户路径；tag 一并重建（`v0.2.0`–`v0.9.0` 全部指向重写后的 commit）。
- **commit message 也重写了一遍**：第一遍只改了工作树，message 里还留着内部编号与一句逐字的用户原话；扫描器补上 message 扫描后才发现（命中 3 条），用 `--msg-filter` 整条替换（只留「问题 + 做法」，不留对话记录）。
- 文档与测试里的本机绝对路径统一改成占位符（`C:\Users\<你>`，URL 形态 `%3C你%3E`）。
- 文档与代码注释里的内部对话编号（形如 `mNNNNN`）改成 **`CR-NN`**（按首次出现的时间顺序编号）。它们是正文里大量交叉引用的锚点（「已被 X 推翻」「见 5.5.7」），所以不能删空，只能换名。
- 真实会话 id 改成占位符 `session-<uuid>`。
- **扫描器的 `real-name` 规则第一版太窄，导致整个流程做了两遍**：它要求「名 + 姓」同时出现，放过了文档里只写裸名的一句话。第一轮重建转 public 之后，用一条更宽的独立检索复核才发现。修法是把规则放宽到只匹配名，并补一条匹配「姓-IT」形态；修完再做一次全历史重写与删库重建（16 个 commit 里只有引入该词的两个 commit 变了 SHA）。
- `test/render.mjs` 不再写死本机安装路径，改用 `DSH_ASAR` / `DSH_INSTALL` 环境变量，默认值仍是 Windows 常见位置；找不到真 React 时 SKIP 并以 0 退出（这是 CI 能跑通的前提）。
- README 补「开发与跑测试」一节；「与 billion-context 的关系」降级为**当时的选型理由**，并注明对方版本一变、行号级依据就可能失效。
- 仓库转为 **public**，并给 `master` 配分支保护：Require status checks = `test`（strict）、禁止强推、禁止删分支、要求对话解决。

### 验证

- 五套测试本地全绿；CI（ubuntu + node 22）两次 `success`。
- 从远端重新 clone 一遍再验：25 个跟踪文件、12 个 commit、9 个 tag、工作树与**全部历史**均 0 命中。本地干净不等于远端干净（`refs/original/`、未推的 tag 都会让假象成立）。
- **第二轮（发现裸名之后）重建的复验读数**：16 个 commit / 9 个 tag / 25 个文件；worktree 与全部历史 0 命中；**commit message 0 命中**；旧 SHA 匿名取 `raw` 与 `.patch` 两条路径**全部 404**，而当前 HEAD 的 `raw` 是 200（排除「URL 拼错导致全 404」的假绿）；CI `success`。

- 转 public 后做**匿名**复验：清空 `credential.helper` 仍能 clone，仓库页与 raw README 均 HTTP 200，API 报 `"private": false` —— 证明陌生访客真的能拿到。

### 发布事故与处置：force push 不会删掉旧 commit

**这一条是本次发布的真实事故，写在这里是因为它可能发生在任何做过历史重写的仓库上。**

- `git push --force` 只移动 ref，**旧 commit 对象仍留在 GitHub 上，且匿名可取**。实测：`raw.githubusercontent.com/<owner>/<repo>/<旧SHA>/<path>` 返回 200，内容里本机用户名命中 6 处；旧 tag 走 `codeload` 打包下载同样可取。
- 当时的仓库已经转成 public，所以旧对象里的本机用户名处于真实匿名暴露状态。**先改回 private 止血**（匿名取仓库页 → 404）。
- **补救只能是删库重建**：GitHub 没有自助回收不可达对象的入口，force push 也不会触发回收。旧对象随旧仓库一起消失。
- 之前「远端干净」的验证漏了一问：只验了「新 clone 的 worktree 与 master 历史 0 命中」，没验「旧 SHA 还在不在」。**验证「已清除」必须去取那个本该消失的东西。**
- 重建后重新配置：description、8 个 topics、`has_discussions=true`（issue 表单的 contact_links 指向它，不开就是死链）、actions 权限、默认分支、master 分支保护。
- **这件事做了两遍**：第一轮重建的仓库里仍留着一处裸名（扫描器规则漏的）。所以「删库重建」不是一个做完就结束的动作，它必须带一个复验闭环：**重建 → 转 public 前先验旧 SHA 是 404 → 用比扫描器更宽的检索再对撞一次 → 全部通过才发布**。


### 推送注意

- 本次改动含 `.github/workflows/test.yml`，**`repo` scope 的令牌推不上去**，会报 `refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`。需先用 `gh auth refresh -h github.com -s workflow` 补权限。判定命令与代理要求见运维手册「症状：`git push` 被拒」。
- `git push` 在 PowerShell 里成功后仍显示 `[exit code: 1]`（git 把进度写 stderr）。判据取 `git ls-remote` 的实际 ref 值。
- 分支保护**只能对 public 仓库或付费账户开启**；private 下调 API 会 `403 Upgrade to GitHub Pro or make this repository public`。所以顺序是「先公开，再配保护」。

### 已知限制

- `test/render.mjs` 需要本机有一份 DSH 安装才能真跑，CI 上恒定 SKIP。所以「首帧渲染」这一层在 CI 上是没有覆盖的，只能本地验证。

---

## 0.9.0 — 规则编辑框改用多行 textarea

- 新增/修改规则的输入框由 `<input>` 改成 `<textarea>`（可换行、可自己拉高）。共 4 处：规则行的编辑态、浮层里两处新建框、设置页的新建框。**围栏文件路径框仍是 `<input>`**（路径里出现换行没有意义）。
- 承重取舍：**`Enter` 归还给换行**，提交键改成 `Ctrl/Cmd+Enter`，并在框下方直接写出这行提示。否则「能换行」这个需求本身就被废掉了。
- 宿主侧零改动：`normalizeText()` 一直是 `value.replace(/\r\n?/g, '\n').trim()`，内部换行原样保留。这一版补了两个用例把它锁成契约。
- 这一版**推翻了 0.3.0 的「不要 textarea」**。当时的场景是「一条规则一个 txt、规则都很短」；到 0.7.0 之后规则正文已是整句整段的中文（现网 10 条里 4 条超过 100 字符），单行框看不全。

## 0.8.0 — 「打开文件夹」不再静默失败

- 修掉两个真实缺陷：①`spawn` 失败是**异步 `'error'` 事件**，原来的 `try/catch` 抓不到，于是无条件回报「已打开」；②前端收到回包后完全不读 `opened` 字段，成功与失败界面一样。
- 现在每次点击都在按钮下方给出结果：已打开 / 未打开 + 原因 / 上一次启动失败的原因（`openWarning`，因为 spawn 是异步的而 HTTP 必须立刻返回，所以失败延后一轮报告）。
- `openFolder` 显式 `windowsHide:false`（A/B 实测：默认与 `false` 都会出窗口，`true` 一定不出）。
- 文档写明：Windows 上 `explorer.exe /select,…` **退出码恒为 1**，不能用作成功判据。

## 0.7.0 — 单文件 JSON + 自定义位置 + 面板同步

- 存储从「一条规则一个 txt」改为**单个 JSON 文件** `fence.json`：`{version, enabled, rules[], sessions{}}`。增删改按数组下标寻址。
- 位置可自定义：优先级 `DIALOG_FENCE_FILE` > 同目录 `location.json` 指针 > 默认 `fence.json`；`DIALOG_FENCE_HOME` 换基目录。
- 新增「打开文件夹」与「更改位置」。改位置**不覆盖已存在的目标文件**（以目标内容为准）。
- 坏 JSON **只告警、返回空围栏，绝不抛异常、绝不改写原文件**；写入用 `.tmp` + rename 原子落盘。
- 修掉面板只统计会话层、导致徽标显示 1 而非 11 的缺陷。

## 0.6.0 — 通用规则层

- 新增**通用规则**：对每一个对话生效（含新开的对话）。设置页主要就是编辑它。
- 设置页不再展示内部会话 id（客户端没有「当前会话 id」的公开 API，展示它对用户无意义），改为编辑通用层。
- 新增 `/fence all` 命令与 HTTP `?scope=common`。

## 0.5.0 — 按组合包安装

- 安装后进入「插件 → 已安装」分组，可用官方安装器装卸；配置区注册到 `plugins.bundle.config`（`key` 必须是 npm 包名，两侧精确相等比较）。
- 数据目录从「包所在目录」改为 `resolveDshHome()/dialog-fence/`：本地路径安装会**复制源码进 generation 快照**，`SELF_DIR` 不稳定，规则会随升级丢。

## 0.4.0 — 设置左栏一级菜单 + 插件页卡片

- 注册 5 个客户端槽位：会话右上角按钮、`shell.overlay` 浮层、`settings.section`（设置左栏一级菜单「对话围栏」）、`settings.plugins.tab`、`plugins.item`。
- `plugins.item` 的语义是「官方分组里的一张卡片」，**无法改到「已安装」分组**，0.5.0 因此换掉它。

## 0.3.0 — 每条规则一个 txt + 插件页 + 修 404

- 存储改为 `rules/state.json`（只存开关）+ `rules/sessions/<sessionId>/NN-<slug>.txt`（一条一文件）。丢 txt 自动启用、改内容即改注入、删文件即删规则。
- 新增 `settings.plugins.tab` 标签页与 `icon.svg`。
- 修「面板左下角 HTTP 404」：`ctx.get('connection')` 是 strict 取值，只返回已激活的服务；改为 `ctx.inject(['connection'], cb)`。

## 0.2.1 — 真 React 渲染测试

- 新增 `test/render.mjs`：从本机 DSH 安装里加载真 React 18 做 `renderToStaticMarkup`，覆盖面板与设置页首帧。
- 修正 `dsh.client.inject`：只列真正可 inject 的 graph entry（`@deepseek-ai/dsh-client-ui-slots` 不是）。

## 0.2.0 — 可视化面板 + 双形态安装

- 首次提交：宿主半边（运行时上下文段 + `/fence` 命令 + `connection.fetch` 路由）+ 浏览器半边（懒 CJS 工厂，只 `require('react')`，无需构建链）。
- 两种安装形态：官方安装器（`dsh plugin add` / 插件管理器）与 `file:///` 挂载（开发用）。
- 注入通道定为 `ctx.systemPrompt.context()`：文本不变返回空串＝零注入，变了才**纯追加**一条完整快照，从不重写系统提示词前缀。

## 0.1.0 — 首次落地（未打 tag、未单独提交）

- 验证「往运行时上下文快照里注入规则」这条路可行：不破坏 KV 前缀缓存、可被压缩插件保护、对其它对话零影响。
