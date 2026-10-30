# 变更记录（CHANGELOG）/ Change log

本文件按版本记录**用户可见的**改动。逐条的设计理由、源码级依据、被否决的替代路线写在
[`docs/设计与实施方案.md`](docs/设计与实施方案.md)，踩过的坑与排查步骤写在
[`docs/运维手册与变更记录.md`](docs/运维手册与变更记录.md)。
This file records **user-visible** changes per version. The reasoning behind each decision, the
source-level evidence and the rejected alternatives live in
[`docs/设计与实施方案.md`](docs/设计与实施方案.md); the traps and troubleshooting steps live in
[`docs/运维手册与变更记录.md`](docs/运维手册与变更记录.md).

版本号从 `0.2.0` 起打 tag；`0.1.0` 是首次落地，从未单独提交过。
Versions are tagged from `0.2.0` on; `0.1.0` was the first drop and was never committed on its own.

---

## 0.13.0 — 每条规则一个启停滑块（单条规则可临时停用，默认启用）

用户要求：围栏的每一条配置都要能单独控制启用 / 不启用，随时把某一条暂时关掉，
**并且配置完就默认启用**。此前只有「总开关」和「本对话启用」两个粒度，想临时停掉
一条规则只能把它删掉再重写。

- **每条规则行尾多了一个滑块按钮**：查看态和编辑态都有，点一下立即生效，不用进编辑态、
  也不用等保存。停用的规则正文会降透明度，一眼能看出「这条暂时不参与注入」。
  滑块带 `role="switch"` 与 `aria-checked`，读屏软件能念出开关状态。
  位置固定在行的**最右端**（序号 → 正文 → 改 / 删 → 滑块）：早一版把滑块塞在序号后面，
  一列规则读下来视线每行都被它截断一次，用户原话「滑块放到右边，在左边太难受了」。
  正文是 `flex:1`，所以贴着右端就等于「排在正文之后、且是该行最后一个子节点」，
  `test/client.mjs` 5.4 段把这两件事都钉死了。
- **默认启用**：新加的规则（`/fence add`、`/fence all add`、面板里的新建框）一律立即生效，
  不需要再手动打开 —— 这正是用户原话「默认是配置以后就启用」的要求。
- **注入层真的按启用过滤**：停用的规则不参与 `renderRuleTexts`，编号按启用后的顺序
  **从 1 连续排**，不会留下「1. 3. 4.」这种空洞。全部规则都被停用时该层视为没有规则，
  渲染结果为空串，一个字符都不注入。
- **存储层零迁移**：`rules` 仍然是纯字符串数组，单条启停位存在与之等长的并行布尔数组
  `ruleEnabled` 上（会话层是 `sessions[id].ruleEnabled`）。这样做的好处是老文件、
  老命令、老前端在升级后都照常工作：缺字段 = 全部启用，手写 JSON 不用改一个字符。
- **停用位会跟着规则平移**：删除第 N 条时 `ruleEnabled` 同步删掉第 N 位，清空 / 重置一起清；
  否则删掉第 0 条之后，后面每一条的开关都会错位一格（这条专门的测试放在
  `test/ruletoggle.mjs` 第 5 段）。
- **命令层面也能用**：`/fence off <序号>` / `/fence on <序号>` 停用或启用本会话第 N 条，
  `/fence all off <序号>` 同理操作通用层。不带序号的 `/fence on | off` 保持原语义
  （整个会话专属层的开关），老用法一个都不变。`/fence status` 与 `/fence all` 的清单里
  停用项前面会标 `[停用]`，并给出「共 N 条，启用 M 条」。
- **HTTP 动作新增 `toggleRule`**：`{ action: 'toggleRule', scope, sessionId, index, enabled }`，
  不传 `enabled` 就当作取反。返回值仍是原来那个快照，只是 `rules[]` 每一项多了
  一个 `enabled` 布尔（`index` / `text` 字段形状没动，前端老代码继续可用）。
- 新增 `test/ruletoggle.mjs`（加入 `npm test` 与 `npm run test:ruletoggle`）：
  10 段断言覆盖「默认启用 / 停用不注入 / 恢复注入 / 落盘格式 / 删除平移 / 清空 /
  会话层 / 老文件兼容 / 全部停用 / 快照字段」。先红后绿：改 `index.js` 之前
  `node test/ruletoggle.mjs` 报 `enabled` 全是 `undefined`、`toggleRule` 返回
  `未知动作 toggleRule`；改完输出 `OK all dialog-fence per-rule toggle assertions passed`。

---

## 0.12.4 — 专属规则下拉不再混进工作区名；四个入口钉成同一个组件

用户报告：设置页「某个对话的额外规则（可选）」的对话下拉里，混进大量
`harness` / `workspace` 选项，夹在真实对话标题之间；同时要求「多个入口进来的设置界面 UI 同步」。

- **下拉里的工作区名（缺陷）**：那些选项不是「工作区被当成了对话」，而是「建了但一句话都没说过」
  的空对话（宿主 `sessions` store 里 `blank === true`）。这种行没有 `title`，宿主的
  `displayTitleOf(title, cwd, id)` 于是退回 `cwd` 的 basename——工作区根目录恰好叫
  `harness`（`C:\...\dsh-desktop\harness`）和 `workspace`（`D:\workspace`），重复出现是因为
  空对话很多。官方侧边栏对 blank 行是**整行藏掉**的（`dsh-client-ui-workspace` 里
  `node.blank ? t("session.new") : ...`），我们照做：候选循环里显式 `if (row?.blank === true) continue;`。
  注意只挡 `blank`，不挡「没起名字但真的用过」的对话——后者仍然列出，显示成 `未命名对话 N`。
- **多入口 UI 同步（加固）**：四个入口（设置左栏、插件页标签页、组合包详情页、会话头浮层）本来就
  注册的是同一个 `FencePage` 组件，浮层只是外面套一层标题壳。这次把这条身份关系**用测试钉死**，
  防止以后有人「顺手复制一份改改」：新增 `test/render.mjs` 3.9 段，断言
  `registrations[2].component === registrations[3].component === registrations[4].component`、
  浮层源码里引用的是 `FencePage`、以及同一个 props 在两个入口渲染出的 HTML 逐字节相同；
  再对四个入口逐一断言「专属规则卡片 / 对话下拉 / 停用启用按钮 / 不显示空对话」都在。

先红后绿：改之前 `test/render.mjs` 3.8 段红在
`AssertionError: a blank conversation must not surface as its cwd basename`，
渲染结果里能直接看到 `<option value="2">harness</option><option value="3">workspace</option>`；
改完 `OK all dialog-fence render assertions passed`。七套测试全绿。

---

## 0.12.3 — 对外介绍改为中英双语、中文优先

无功能改动，只改对外文案与新增一条测试。

- `README.md`：开头摘要改为中文四行 + 英文四行（中文在前）；所有标题（含本次新增的小节，现共 28 个）全部改成「中文 / English」并列；
  新增 `## 英文概览 / English overview` 一节，用英文把「是什么 / 为什么不写进系统提示词 / 本插件怎么做 /
  在哪编辑 / 怎么装 / 有哪些测试 / 文档在哪」讲完，让只读英文的人不必先读中文。
- `package.json` 的 `description`：改为中文优先的中英双语。这个字段同时喂给三处——DSH 插件页的卡片
  标题与描述、npm 页面、以及社区清单条目，所以中文放前面。
- `.github/SECURITY.md`、`.github/pull_request_template.md`、`.github/ISSUE_TEMPLATE/*.yml`：
  逐条补英文，中文句在前、英文句紧跟其后。
- 顺带修掉一处**过时的事实**：`SECURITY.md` 原来写「只维护 `dsh.compatibility.dshReleases` 声明过的
  DSH 版本」，而那个字段在 0.12.1 已确认是死字段（全 asar 零命中），真正被读的是 `engines.dsh`。
- 新增 `test/docs.mjs`：机器检查「中文优先」这条路没有被悄悄退回去。它钉住的是**结构**，不是文笔：
  `package.json` 的 `description` 必须中英文都有且中文先出现；README 的每个一/二/三级标题必须中英并列；
  开头摘要中英文块引用各至少三行且中文在前；存在英文概览小节；`.github` 下四个对外文件各自中英兼备。
- `docs/设计与实施方案.md` 与 `docs/运维手册与变更记录.md`：**只改入口层**——一级标题、全部二级章标题、
  开头摘要块补上英文并列；正文保持中文（这是内部工程记录，做成双语对照本收益远小于维护成本）。
- `npm test` 从六套变七套（新增 `docs`），`npm run test:docs` 可单跑。

先红后绿：改之前 `test/docs.mjs` 报 23 处（`package.json` 缺中文、19 个标题缺英文、开头没有英文摘要、
没有英文概览小节），改完 `OK all docs assertions passed（27 个标题中英并列，8 段摘要分中英）`；随后补入「仓库 About 与逐条文案的双语规则」小节，标题变 28 个。

仓库 About（右侧那句描述）不在仓库里，靠 `gh api -X PATCH repos/... -f description=...` 改，
测试管不到——这一点写进了 README 的「上架清单」。

---

## 0.12.2 — 确立「改完就发 npm，两边不留版本差」的规则

无代码改动，只补文档与规则。起因是一次真实的不同步：0.12.0 发到 npm 后，仓库又推了
0.12.1（CR-19 的按钮挤行修复）却没打 tag，于是仓库 0.12.1 / npm 0.12.0 ——
按 README 用 `npm i dsh-dialog-fence` 装到的人拿到的是没修 UI 的那个版本。

- README「发布到 npm」新增小节「长期规则：改完就发，两边不留版本差」，给出三条核对命令
  （`git describe --tags --abbrev=0` / `node -p "require('./package.json').version"` /
  `npm view dsh-dialog-fence version`）。
- 运维手册新增 §7.2.1，写清执行口径：升版本 + 写 CHANGELOG → 提交推送 → 打 `v*` tag 推送，
  一件都不能省；仓库领先 npm 时补推 tag 即可，不必重新提交代码。
- CHANGELOG 里两条旧条目原本标「未发布」，实际早已随 0.12.0 发出（`3aec000` / `e9e4fc1`
  都是 `v0.12.0` 的祖先），改成「0.12.0 起可用」以免下一个人误以为漏发。

0.12.1 本身也已补发到 npm（此前只推了代码没发版），这一步正是本规则要防的情况。

---

## 0.12.1 — 「某个对话的额外规则」卡片：按钮与计数不再挤成一行

设置页（以及复用同一套卡片的浮层）里，「某个对话的额外规则（可选）」这张卡原本把
`对话` 标签、下拉框、`停用该对话` 按钮、`N/40 条专属规则` 计数全塞在一个
`display:flex; nowrap` 的单行里。下拉框写死了 `min-width:200px; max-width:320px`，
在 476px 宽的浮层里吃掉大半宽度，剩下的空间不够，于是按钮被压成「停用该对 / 话」
两行、计数被压成「1/40 / 条专 / 属规 / 则」四行。

改成两行，且每一段都不许折行：

- 第一行：`对话` 标签 + 下拉框（`flex:1; min-width:0`，宽度跟着卡片走，不再固定）；
- 第二行：`停用/启用该对话` 按钮 + `N/40 条专属规则` 计数（两者 `flex:none; white-space:nowrap`）。

新增 CSS 类 `.dialog-fence-picker` / `.dialog-fence-picker-row` / `.dialog-fence-count` /
`.dialog-fence-label`。`test/render.mjs` 新增 3.7 组断言钉住这个形状（`.dialog-fence-picker`
存在、`.dialog-fence-picker-row` 恰好 2 个、计数不再是 `style="flex:1"` 的 meta、
下拉框 CSS 含 `flex:1`），先红后绿。

---

## 0.12.0 起可用 — 发布链路：`v*` tag 触发 GitHub Actions 发 npm（无 token）

新增 `.github/workflows/publish.yml`：推 `v*` tag（或手动 `Run workflow`）时，
校验 tag 与 `package.json` 版本一致 → `npm test` → `npm pack` → 发布那份 tgz →
上传 tgz 留档。

用的是 npm **trusted publishing**（GitHub Actions OIDC 换一次性凭据），
所以仓库里**没有任何 `NPM_TOKEN` / `_authToken`**，本机也不需要 `npm login`。

新增 `test/release.mjs`（纯静态断言，零依赖）把红线钉住：workflow 里出现
`secrets.` / `NPM_TOKEN` / `NODE_AUTH_TOKEN` 就红；`npm test` 必须排在
`npm publish` 之前；`permissions` 必须有 `id-token: write`；`package.json`
不得有 `private`、`files` 不得把用户的 `fence.json` 打进包里。

写这个测试时踩了两个坑，都记在运维手册 7.5：①第一版直接扫整个 workflow 文本，
被自己注释里那句「不需要 NPM_TOKEN」判红 —— 必须先剥注释再扫；②`npm test` 与
`npm publish` 的先后比较两边必须用同一份「已剥注释」的文本，否则误报顺序错。

后来真发 0.12.0 时又踩了两个，一并修掉（`test/release.mjs` 已加到 13 组断言）：

- **手动触发会发出「不是 tag 那份」的内容**。`v0.12.0` 打在 `6ad7961`，之后又推了
  3 个 commit 再手动触发，于是 checkout 拿到分支 HEAD，npm provenance 记的也是那个
  HEAD，而 tag 还指着前一个 commit —— 按 tag 重新打包会得到另一个 shasum，tag 失去
  溯源意义。修法：`workflow_dispatch` 增加 `publish_ref`，checkout 用它，并校验
  HEAD 就是该 tag。**发版请推 tag，别用手动触发。**
- **移动 tag 会重跑 workflow，而版本已在 registry 上**，`npm publish` 必然 E403，
  于是「修正 tag」这种动作也会发失败通知。修法：先 `npm view <pkg>@<version> version`
  判断是否已发布，已发布就整步跳过。

一次性配置（只在 npmjs.com 网页上做一次）：包 → Settings → Trusted Publisher →
GitHub Actions，Owner `ILoveHAKU` / Repository `dsh-dialog-fence` /
Workflow `publish.yml`。填完两天内要完成首次发布，否则过期。

---

## 0.12.0 起可用 — 文档：补充「上架社区清单」与踩坑

无代码改动。README 新增「上架清单（awesome-dsh-plugin / 插件市场）」一节，运维手册新增
「六、发布到社区清单」整章，把这次投稿实际撞到的规则与坑写下来：

- 清单只收「一个插件一个 YAML」（`data/plugins/<owner>__<repo>.yml`），README 由脚本生成、手改会红。
- 条目 `icon:` 只接受 GitHub 托管位图，**SVG 被拒**；`package.json` 的 `icon: "./icon.svg"` 只对 DSH 插件页有效。
- 收录 ≠ 市场能搜到：`plugins.json` 收 GitHub-only 条目（收录后 dshmarket 就能搜到），`index.json` 只收已发 npm 的；后者靠 `probe-npm.mjs` 采集，条件是 registry 的 `repository` 指回本仓库。
- 本地先跑官方 gate 需要 `GITHUB_TOKEN` + 代理 + 一个 `{"type":"module"}` 与 js-yaml 的临时环境。
- 用 GitHub contents API 提 PR 时，**必须先 `POST /git/refs` 建分支**，否则 `PUT contents` 直接 404。

收录 PR：[awesome-dsh-plugin#9530](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9530)。

---

## 0.12.0 — 浮层与设置页合成同一套界面（用户 CR）

### 修复

- **右上角「围栏」浮层现在和设置页是同一套卡片**：浮层以前是自己的一份实现，只有「通用规则 + 仅本对话」两段裸列表，
  没有卡片分区、没有对话选择器 —— 设置页能选任意对话改专属规则，浮层只能改当前这一条，两边看着不像一家人。
  现在浮层直接渲染设置页的紧凑版（`FencePage` 的 `flat` 版式），分区、文案、按钮、说明全部共用一份代码
  （`client.js` 里删掉了浮层那份重复实现，`client.js` 净减 ~110 行）。
- **浮层里也能针对「任意一条对话」配置专属规则**：本轮给 `FencePage` 加了 `preferredSessionId`，
  浮层把「点开它的那条对话」传进去，下拉默认就停在那条对话上；即使 sessions store 还没加载完，
  也会把它补成一个候选（显示「当前对话」），不会出现「浮层点开却选不到自己」。
- **两侧都能单独停用某一条对话的围栏**：设置页第三张卡片的对话下拉旁新增「停用该对话 / 启用该对话」
  （按该对话自己的 `enabled` 判断），此前这个动作只在浮层顶部有，设置页做不到。

### 验证

- `test/render.mjs` 新增 3.6 段：用真 React 18 渲染 `FencePage({flat:true, preferredSessionId, useSessions})`，
  断言它同时具备 `.dialog-fence-card`、`.dialog-fence-select`、「围栏规则（对每个对话生效）」「某个对话的额外规则（可选）」
  「添加专属规则」「停用该对话|启用该对话」「打开文件夹」，不泄露 sessionId，且 **不再有 `dialog-fence-foot`**（一次性底部工具条已废）。
  另断言 `preferredSessionId` 指向第二条对话时，那个 `<option>` 带 `selected`。
- `test/client.mjs` 的 textarea 计数断言从 5 改为 3 —— 这是**统一的证据**：过去浮层自己又抄了一份新建框，
  现在整个 bundle 只剩 1 个规则编辑器 + 2 个新建框（通用层、专属层）。
- 五套测试全部 `exit=0`：`smoke` / `route` / `client` / `render` / `opensource`。

---

## 0.11.1 — 适配 DSH Desktop 0.12.1（无功能改动）

### 修复

- **错误文字的颜色改用 0.12.1 仍在的主题 token**：`--dsw-alias-state-danger-primary` →
  `--dsw-alias-state-error-primary`（`client.js`，只有这一行）。旧 token 在 0.12.1 的主题里已经不存在，
  而写法是 `var(--x,#d33)`，所以它不会报错、只是**静默退化成硬编码红色**——不跟主题、深色模式下一眼能看出来。
  用 `cordis_inspect` 的 `Theme.listTokens` 比对：0.12.1 声明 403 个 token，`client.js` 用到 13 个，只有这一个是坏的。

### 变更

- **兼容性声明从死字段挪到真正被读的字段**：删掉 `dsh.compatibility.dshReleases`（全 asar 0 命中，没有任何代码读它），
  改在 `engines.dsh` 里声明 `">=0.2.0 <0.3.0"`。DSH 的判定函数是
  `dsh-app-boot/lib/index.js:279 unmetRequirements()`：**只看 `engines.dsh`**，没有它才退回 `peerDependencies`。
  之所以要写上界：0.x 期间次版本会带破坏性改动（本插件就踩到过主题 token 改名），下界放开、上界锁住次版本，
  以后 0.3 发布时 DSH 会明确提示「不兼容」而不是静默加载后出现难查的样式问题。

### 关于「版本不符合会怎样」（实测，不要误以为会被禁用）

`dsh-app-boot/lib/index.js:2362 denial()` 调完 `evaluatePluginCompatibility()` 后
**一律 `return void 0`**（只 `reportPluginCompatibility(issue)` 打一行 warning），
只有 catch 到异常才返回字符串去 `deny()`。而 `:1064`（profile bundle 组装）同样只报 warning。
所以 `engines.dsh` 写窄了**不会**让插件被 disable，只是打一行
`[desktop] compatibility warning: ...`。真正会被 `row.disabled = true` 的只有「声明无法校验」这一种。

### 验证

五套测试全绿（`smoke` / `route` / `client` / `render` / `opensource`），在 0.12.1 上实跑。
本轮新增两条断言，都是先让它变红再修：

- `test/render.mjs` 第 5 组：读 asar 里 `dsh-client-ui-theme/lib/client.js` 的 token 声明集合，与 `client.js`
  用到的 token 集合求差，要求为空。未修时报
  `AssertionError: client.js references theme tokens the current DSH theme does not declare: --dsw-alias-state-danger-primary`。
- `test/client.mjs` 第 7 组：要求 `engines.dsh` 非空、且 `dsh.compatibility` 不存在。把 `engines.dsh` 删掉、
  死字段加回来时报 `AssertionError: engines.dsh is declared (the only field DSH reads)`。

### 0.12.1 适配结论（除上面两点外全部兼容，逐项实测）

- 五个客户端槽位全部存在且本插件注册项 `active`：`settings.section`、`settings.plugins.tab`、
  `plugins.bundle.config`、`conversation.session.header.utilities`、`shell.overlay`。
- 宿主 API 无破坏：`connection.fetch.register` / `assertFetchRoute` / `API_PATH` 都在；
  `systemPrompt.context()` 签名不变（`text` 仍支持函数）；`commands.register()` 不变。
- `CONTEXT_ORDER = 118` 仍有效：它落在 `APPROVAL_POLICY: 115` 与 `SUBAGENT_DELEGATION: 120` 之间，
  而 `CONTEXT_ORDERS` 是给调用方参考的枚举表、**不是白名单**，`refreshContext()` 对任意数值 order 都接受。
- `dsh-api-session-controller` 的 `byId[id]` 形状不变：`title` / `displayTitle` / `retainedBy` / `running` 都在
  （`sessionTitle` 这个字段名在本版 **0 命中**，是旧结论，已作废）。本插件用 `title ?? displayTitle` 并挡掉
  返回值等于 id 的情况，与 0.12.1 契约一致，无需改。

### 注意

- 改的是 `client.js`，**装过的 generation 快照里仍是旧代码**，必须重装 + 重启页面才生效。
- 同环境下 `@deepseek-ai/dsh-subagent-codex@0.1.7-rc.2` 与 0.12.1 **确实不兼容**
  （启动日志：`SyntaxError: The requested module '@deepseek-ai/dsh-subagent' does not provide an export named 'resolveChildCwd'`）。
  那不是本插件的问题，但会出现在同一份启动日志里，排查时别误判。

---

## 0.11.0 — 上 npm，让「官方插件市场」能搜到

### 变更

- `package.json` 去掉 `"private": true`（发包前提），版本升到 0.11.0。
- 新增 `assets/settings-page.png`、`assets/conversation-panel.png` 与 `screenshots.json`：
  截图是用真 React + 真 `client.js` 组件 + 真主题 CSS 静态渲染后由 headless Chrome 截的，
  不是手工拼的示意图；`screenshots.json` 是 DSH 插件市场认的截图清单格式。
- `dsh-dialog-fence@0.11.0` 已发布到 npm 公共 registry（本仓库从 0.11.0 起同时支持
  `dsh plugin --profile web add dsh-dialog-fence` 从 npm 装）。

### 已知遗憾

- registry 上有一个 `0.0.0-stage` 占位版本（npm 首次发布时自动创建的），本地 `npm unpublish`
  被 403 拒绝（账号的 2FA 策略不允许绕过），已用 `npm deprecate` 标注，不影响 `latest`。

---

## 0.10.0 — 设置页可以编辑「某个对话的专属规则」；浮层支持点外部关闭

### 新增

- **设置页补上「某个对话的额外规则」编辑区**。此前这里只有一句说明文字（「去点那个对话右上角的围栏按钮」），
  用户想在设置页给某个对话加一条专属规则是做不到的。现在它和浮层下半部分完全一致：规则逐条「改」「删」、
  底部新建框、`Ctrl+Enter` 保存、「添加专属规则」/「清空该对话的专属规则」。
- **对话下拉显示对话名称，并且默认选中当前对话**。选项文字取自 `useSessions` 投影的 `displayTitle`
  （重命名过就是用户起的名字，否则是项目目录名，两者都没有才显示「未命名对话 N」），
  当前对话标「（当前）」。**任何情况下都不会把 `session-<uuid>` 显示出来** —— `<option>` 的 value
  用的是数组下标而不是会话 id。归到「已归档对话 N」的条目也没有名称可显示，同样不暴露 id。
- **浮层支持点击外部关闭**。此前只能点「关闭」按钮、或再点一次右上角「围栏」按钮。

### 变更

- 设置页第三张卡的标题从「某个对话的额外规则（可选）」改名为「某个对话的额外规则」，正文说明改为
  「下面这一层只叠加到所选对话，不影响其它对话；右上角「围栏」浮层改的是同一份数据」。
- 浮层与设置页现在共用同一套「专属规则」操作；浮层继续绑定当前会话（它本来就带 `sessionId`）。

### 实现要点（为什么不需要改宿主）

- `settings.section` / `settings.plugins.tab` / `plugins.bundle.config` 三个槽位的 `standardProps`
  **都带 `useSessions`**，所以「对话列表 + 名称 + 当前对话」全在客户端就拿得到，插件没有新增任何 HTTP 动作，
  `index.js` 一行未改。
- 「当前对话」的判据照抄 DSH 自己的 `mainSessionId()`：`retainedBy.mainView > 0` 那一行。
- 用 `useSessions((state) => state?.byId ?? null)` 而不是 `(state) => state.byId` 的新对象：
  它底层是 `useSyncExternalStore`，每次返回新对象会让快照身份一直变。
- 子代理（`origin === 'subagent'`）不列进下拉：它不是用户眼里的「对话」。
- 点外部关闭用 `document` 的 `mousedown` 捕获阶段 + `ref.contains()` 判定，并显式忽略
  `.dialog-fence-trigger`（右上角那个按钮），否则「点按钮关闭 → 按钮 onClick 又打开」会打架。

### 验证

五套测试全绿（`smoke` / `route` / `client` / `render` / `opensource`）。本轮新增的断言：

- `test/render.mjs` 用真 React 渲染带 `useSessions` 桩的设置页，断言下拉里出现对话名、
  当前对话被选中且标「（当前）」、**整页不出现 `session-<uuid>`**（含 `<option>` 的 value）。
- `test/client.mjs` 用真 `useEffect` 的桩把浮层挂起来，派发 `document` 的 `mousedown`：
  面板内部按下不关、外部按下关闭、按在右上角「围栏」按钮上不关；另断言监听在卸载时被移除。

### 已知限制

- 下拉只能列出**当前进程里活着**的对话，加上围栏文件里已经有规则的对话（显示为「已归档对话 N」）。
  已经归档、进程里也不存在、围栏里又没给它设过规则的对话，不会出现在列表里 —— 但它本来也没有可编辑的内容。

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
