/**
 * 浏览器半边的「真 React」渲染测试。
 *
 * test/client.mjs 用假 React 直接当普通函数调用组件 —— 这能验证形状，
 * 但没有真正的 hooks 运行时（useState/useEffect 只是空实现）。
 * 本文件用 DSH 自带的真 React 18（asar 内 node_modules/react）配合
 * react-dom/server.browser 的 renderToStaticMarkup 真正渲染一次，
 * 从而确认组件在 hooks 运行时下不违规、不抛错、产出预期 DOM 结构。
 *
 * 注意：renderToStaticMarkup 不执行 useEffect，所以这里只覆盖
 * 「首帧渲染」；「点击后拉数据」需要真浏览器（见运维手册的验证步骤）。
 *
 * 运行（与其它测试相同）：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "D:\DSH Desktop\DSH Desktop.exe" "...\dialog-fence\test\render.mjs"
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 真 React 从「本机这一份 DSH 安装」里取。默认按 Windows 常见安装位置拼，
// 也允许用环境变量覆盖（CI 上没有 DSH 安装，本测试会 SKIP 并通过）：
//   DSH_ASAR    = <app.asar>\node_modules 的绝对路径
//   DSH_INSTALL = DSH 安装目录（其下有 resources\app.asar\node_modules）
const ASAR =
  process.env.DSH_ASAR ||
  join(process.env.DSH_INSTALL || 'D:\\DSH Desktop', 'resources', 'app.asar', 'node_modules');
const REACT = join(ASAR, 'react', 'index.js');
const REACT_SERVER = join(ASAR, 'react-dom', 'server.browser.js');
const CLIENT_FILE = join(import.meta.dirname, '..', 'client.js');

if (!existsSync(REACT) || !existsSync(REACT_SERVER)) {
  console.log('SKIP dialog-fence render test: real React not found next to this DSH install');
  process.exit(0);
}

const React = (await import(new URL(`file:///${REACT.replaceAll('\\', '/')}`).href)).default;
const { renderToStaticMarkup } = await import(new URL(`file:///${REACT_SERVER.replaceAll('\\', '/')}`).href);
console.log(`   react: ${React.version}`);

// ---- 假 window / document（与 client.mjs 同款，只为接住 load() 与 CSS 注入）----
const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
globalThis.document = {
  querySelector: () => null,
  createElement: (tag) => ({ tag, dataset: {}, textContent: '' }),
  head: { appendChild() {} },
};
// fetch：渲染期不会触发（不跑 effect），但留个显式桩，避免意外联网
globalThis.fetch = async () => {
  throw new Error('render test must not perform network requests');
};

const source = readFileSync(CLIENT_FILE, 'utf8');
new Function('window', 'document', 'module', 'exports', source)(globalThis.window, globalThis.document, { exports: {} }, {});

const definition = loaded[0];
assert.equal(definition.id, 'dsh-dialog-fence');

const clientExports = definition.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require("${specifier}")`);
});

// 抓 slot 注册表拿组件
const registrations = [];
clientExports.apply({
  effect: (fn) => fn(),
  slots: {
    inject: (_name, callback) => callback(),
    register: (spec, component) => {
      registrations.push({ spec, component });
      return () => {};
    },
  },
});
assert.equal(registrations.length, 5, 'header + overlay + settings section + plugins tab + bundle config');
const HeaderAction = registrations[0].component;
const Panel = registrations[1].component;
const FencePage = registrations[2].component;
const PluginsTab = registrations[3].component;
const BundleConfig = registrations[4].component;
assert.equal(registrations[4].spec.name, 'plugins.bundle.config');
assert.equal(registrations[4].spec.key, 'dsh-dialog-fence');

// ---- 1) 头部按钮：真 hooks 下渲染 ------------------------------------------
const headerMarkup = renderToStaticMarkup(React.createElement(HeaderAction, { sessionId: 'session-render-1' }));
console.log(`   header: ${headerMarkup}`);
assert.match(headerMarkup, /^<button/, 'renders a <button>');
assert.match(headerMarkup, /class="dialog-fence-trigger"/);
assert.match(headerMarkup, /data-on="false"/, 'defaults to disabled (no rules recorded)');
assert.match(headerMarkup, /围栏/);
assert.doesNotMatch(headerMarkup, /dialog-fence-badge/, 'no badge when the session has no rules');

// ---- 2) 浮层面板：未打开任何会话时返回 null（不占 DOM）---------------------
assert.equal(renderToStaticMarkup(React.createElement(Panel)), '', 'overlay renders nothing while closed');

// ---- 3) 配置页：首帧（快照尚未返回）也要渲染总开关与规则编辑骨架 ---------------
const pageMarkup = renderToStaticMarkup(React.createElement(FencePage));
console.log(`   settings section: ${pageMarkup.slice(0, 160)}…`);
assert.match(pageMarkup, /class="dialog-fence-page"/, 'settings section renders its page container');
assert.match(pageMarkup, /对话围栏/, 'settings section shows the plugin title');
assert.match(pageMarkup, /总开关/, 'settings section exposes the global switch');
assert.match(pageMarkup, /开启围栏|关闭围栏/, 'global switch is actionable');
assert.match(pageMarkup, /读取中/, 'first frame shows the placeholder until the common layer arrives');
assert.match(pageMarkup, /围栏规则（对每个对话生效）/, 'the rule list is the main view, not a session table');
assert.match(pageMarkup, /dialog-fence-textarea/, 'has a multiline box for a new rule');
assert.match(pageMarkup, /打开文件夹/, 'settings page can reveal the fence file');
assert.match(pageMarkup, /更改位置/, 'settings page can move the fence file');
assert.doesNotMatch(pageMarkup, /session-[0-9a-f]{8}-/, 'no session ids on the settings page');
assert.match(pageMarkup, /<textarea/, 'the new-rule box is a real textarea in the DOM');
assert.match(pageMarkup, /rows="3"/, 'the new-rule textarea is three lines tall');

// 插件页标签页复用同一个组件
const tabMarkup = renderToStaticMarkup(React.createElement(PluginsTab));
assert.match(tabMarkup, /class="dialog-fence-page"/, 'plugins tab renders its page container');

// ---- 3.5) 会话选择器：显示对话名称，绝不显示 sessionId ---------------------
// 槽位把 useSessions 作为 standardProp 传进来（settings.section /
// settings.plugins.tab / plugins.bundle.config 三处都有）；用它既能拿到名称，
// 也能认出「当前对话」＝ retainedBy.mainView > 0。
// 占位 id 故意用非十六进制字母，既能被当成「像 id 的字符串」，
// 又不会撞上泄漏扫描器的「真实 session id」规则（那条规则只认 UUID 形的十六进制）。
const S1 = 'session-zzzzzzzz-yyyy-wwww-vvvv-uuuuuuuuuuuu';
const S2 = 'session-tttttttt-ssss-rrrr-qqqq-pppppppppppp';
// 占位 id 一律只用非十六进制字母（g-z）：既能被当成「像 id 的字符串」，
// 又不会撞上泄漏扫描器的「真实 session id」规则（那条规则只认 UUID 形的十六进制）。
const S3 = 'session-oooooooo-nnnn-mmmm-llll-kkkkkkkkkkkk';
const S4 = 'session-jjjjjjjj-iiii-hhhh-gggg-zzzzzzzzzzzz';
const fakeSessions = {
  ids: [S1, S2, S3, S4],
  byId: {
    [S1]: {
      id: S1,
      displayTitle: 'SQL 邮件提醒遗漏排查',
      title: 'SQL 邮件提醒遗漏排查',
      retainedBy: { mainView: 1 },
      blank: false,
    },
    // 这一行没有标题、displayTitle 也已退化成 id —— 界面必须自己挡掉，改用「未命名对话」。
    // 注意它 blank:false：真的开过、只是没起名字，这种应当出现在下拉里。
    [S2]: { id: S2, displayTitle: S2, retainedBy: {}, blank: false },
    // 下面两行是「建了但一句话都没说过」的空对话。宿主给它们的 displayTitle 是
    // cwd 的 basename（见 dsh-api-session-controller 的 displayTitleOf），
    // 于是下拉里会冒出一堆 `harness` / `workspace` —— 用户 CR-20。
    [S3]: { id: S3, displayTitle: 'harness', retainedBy: {}, blank: true },
    [S4]: { id: S4, displayTitle: 'workspace', retainedBy: {}, blank: true },
  },
};
const useSessionsStub = (selector) => selector(fakeSessions);
const withSessionsMarkup = renderToStaticMarkup(
  React.createElement(FencePage, { useSessions: useSessionsStub }),
);
console.log(`   settings section + sessions: ${withSessionsMarkup.slice(0, 160)}…`);
assert.match(withSessionsMarkup, /class="dialog-fence-select"/, 'the page offers a conversation picker');
assert.match(withSessionsMarkup, /SQL 邮件提醒遗漏排查/, 'the picker shows the conversation title');
assert.match(withSessionsMarkup, /（当前）/, 'the conversation being viewed is marked as current');
assert.match(withSessionsMarkup, /未命名对话 2/, 'a row without a title gets a readable fallback, not its id');
assert.doesNotMatch(withSessionsMarkup, /session-zzzzzzzz-yyyy-/, 'the picker never shows a session id');
assert.doesNotMatch(withSessionsMarkup, /session-tttttttt-ssss-/, 'the fallback never leaks the id either');
assert.match(withSessionsMarkup, /某个对话的额外规则（可选）/, 'the per-conversation card keeps its title');
assert.match(
  withSessionsMarkup,
  /添加专属规则/,
  'the settings page can now add a per-conversation rule (previously read-only text)',
);

// ---- 3.6) 浮层与设置页必须是同一套卡片（0.12.0 统一两处界面）---------------
// 用户 CR-18：右上角「围栏」浮层过去是另一套实现，没有设置页里「针对单独对话
// 的单独配置」（对话下拉 + 专属规则卡），两处长得也不一样。
// 现在浮层直接渲染 FencePage —— 同一个组件、同一套卡片、同一个对话下拉，
// 只额外套一层壳（标题 / 总开关状态 / 关闭）。下面渲染的正是浮层里那一份。
const overlayCardsMarkup = renderToStaticMarkup(
  React.createElement(FencePage, {
    flat: true,
    preferredSessionId: S1,
    useSessions: useSessionsStub,
  }),
);
console.log(`   overlay cards: ${overlayCardsMarkup.slice(0, 160)}…`);
assert.match(overlayCardsMarkup, /class="dialog-fence-flat"/, 'the overlay renders the cards without page padding');
assert.match(overlayCardsMarkup, /class="dialog-fence-card"/, 'the overlay reuses the settings-page cards');
assert.match(overlayCardsMarkup, /class="dialog-fence-select"/, 'the overlay offers the same conversation picker');
assert.match(overlayCardsMarkup, /围栏规则（对每个对话生效）/, 'the overlay shows the shared rule layer');
assert.match(overlayCardsMarkup, /某个对话的额外规则（可选）/, 'the overlay carries the per-conversation card');
assert.match(overlayCardsMarkup, /SQL 邮件提醒遗漏排查/, 'the overlay picker shows conversation names');
assert.match(overlayCardsMarkup, /添加专属规则/, 'the overlay can add a per-conversation rule');
assert.match(overlayCardsMarkup, /启用该对话|停用该对话/, 'the overlay can enable or disable the selected conversation');
assert.match(overlayCardsMarkup, /打开文件夹/, 'the overlay keeps the open-folder action');
assert.doesNotMatch(overlayCardsMarkup, /session-zzzzzzzz-yyyy-/, 'the overlay never shows a session id');
assert.doesNotMatch(overlayCardsMarkup, /dialog-fence-foot/, 'the one-off footer is gone: its buttons live in the cards now');

// 浮层要能定位到「点开它的那条对话」：preferredSessionId 优先于「当前对话」。
const preferredMarkup = renderToStaticMarkup(
  React.createElement(FencePage, { flat: true, preferredSessionId: S2, useSessions: useSessionsStub }),
);
assert.match(
  preferredMarkup,
  /<option[^>]*selected[^>]*>未命名对话 2</,
  'the overlay preselects the conversation it was opened from, not the globally current one',
);

// ---- 3.7) 对话选择器不能挤成一行（用户 CR-19）--------------------------------
// 事故样子：`对话 [下拉 200~320px] [停用该对话] 1/40 条专属规则` 全塞进
// `.dialog-fence-card-head`（一个 nowrap 的 flex 行）。浮层只有 476px 宽，
// 下拉吃掉 320px 后，按钮和计数被压到各自只剩一个字宽，中文逐字换行成
// 「停用该对 / 话」和「1/40 / 条专 / 属规 / 则」——看起来就是文字挤出去了。
// 现在拆成两行：第一行「对话 + 下拉（flex:1，不再固定 max-width）」，
// 第二行「停用/启用 + 计数」。按钮与计数一律 nowrap。
assert.match(withSessionsMarkup, /class="dialog-fence-picker"/, 'the picker gets its own two-row block');
assert.match(withSessionsMarkup, /class="dialog-fence-picker-row"/, 'the picker renders explicit rows instead of one crowded line');
assert.equal(
  (withSessionsMarkup.match(/class="dialog-fence-picker-row"/g) ?? []).length,
  2,
  'the picker is exactly two rows: the select, then the toggle plus the count',
);
assert.match(withSessionsMarkup, /class="dialog-fence-count"/, 'the rule count uses its own non-wrapping class');
assert.doesNotMatch(
  withSessionsMarkup,
  /<span class="dialog-fence-meta" style="flex:1">\d+\/\d+ 条专属规则/,
  'the count no longer rides inside an unrelated flex:1 meta span',
);
assert.match(
  source,
  /\.dialog-fence-select\{[^}]*flex:1/,
  'the select grows to fill its row instead of keeping a fixed max-width',
);

// ---- 3.8) 空对话不得进入下拉（用户 CR-20）------------------------------------
// 事故样子：下拉里冒出大量 `harness` / `workspace` 选项。
// 根因不是「工作区被当成了对话」，而是那些「建了但一句话没说过」的空对话
// （宿主 sessions store 里 blank === true）没有 title，displayTitleOf() 于是
// 退化成 cwd 的 basename —— 工作区根目录恰好叫 harness / workspace。
// 官方侧边栏对 blank 行是整行藏掉的（dsh-client-ui-workspace 的 displayTitle
// 里 `node.blank ? t("session.new") : ...`），我们照做：
// 既不列进下拉，也不让它顶替「当前对话」的判断。
assert.doesNotMatch(withSessionsMarkup, />harness</, 'a blank conversation must not surface as its cwd basename');
assert.doesNotMatch(withSessionsMarkup, />workspace</, 'a blank conversation must not surface as its cwd basename');
assert.equal(
  (withSessionsMarkup.match(/<option/g) ?? []).length,
  2,
  'only the two real conversations are offered; the blank ones are hidden entirely',
);
assert.match(source, /blank === true\) continue/, 'the candidate loop drops blank rows explicitly');

// ---- 3.9) 四个入口必须是同一套界面（用户 CR-20 第二句）----------------------
// 用户原话：「保证多个入口进来的设置界面UI同步」。
// 同步的唯一可靠做法不是「四处各写一份、再互相抄」，而是四处注册**同一个组件**。
// 这里钉的就是这个身份关系：设置左栏 / 插件页标签页 / 组合包详情页拿到的是同一个
// 函数对象，浮层里渲染的也是它。任何一次「顺手复制一份改改」都会让这条断言立刻红。
assert.equal(registrations[2].component, registrations[3].component, 'settings section and plugins tab are the same component');
assert.equal(registrations[2].component, registrations[4].component, 'bundle config page is the same component too');
assert.equal(Panel.toString().includes('FencePage'), true, 'the overlay renders that same component instead of its own copy');
// 同样的 props 渲染出同样的 HTML —— 成分相同、文案相同、顺序相同。
const sameA = renderToStaticMarkup(React.createElement(FencePage, { useSessions: useSessionsStub }));
const sameB = renderToStaticMarkup(React.createElement(registrations[3].component, { useSessions: useSessionsStub }));
assert.equal(sameA, sameB, 'two entry points render byte-identical markup for the same props');
// 每个入口都要能长出同一张「某个对话的额外规则」卡片，而不是只有设置页有。
for (const [label, component, props] of [
  ['settings section', FencePage, { useSessions: useSessionsStub }],
  ['plugins tab', registrations[3].component, { useSessions: useSessionsStub }],
  ['bundle config', registrations[4].component, { view: 'page', useSessions: useSessionsStub }],
  ['overlay', FencePage, { flat: true, preferredSessionId: S1, useSessions: useSessionsStub }],
]) {
  const markup = renderToStaticMarkup(React.createElement(component, props));
  assert.match(markup, /某个对话的额外规则（可选）/, `${label} carries the per-conversation card`);
  assert.match(markup, /class="dialog-fence-select"/, `${label} offers the conversation picker`);
  assert.match(markup, /停用该对话|启用该对话/, `${label} can toggle that conversation`);
  assert.doesNotMatch(markup, />harness</, `${label} hides blank conversations`);
}

// ---- 4) 组合包详情页里的配置区（owner 只传 view: 'page'）---------------------
const bundleMarkup = renderToStaticMarkup(React.createElement(BundleConfig, { view: 'page' }));
assert.match(bundleMarkup, /class="dialog-fence-flat"/, 'bundle config renders the flat (no outer padding) variant');
assert.match(bundleMarkup, /总开关/, 'bundle config carries the global switch');
assert.match(bundleMarkup, /对话围栏/, 'bundle config shows the plugin title');

// ---- 5) CSS 变量必须都在「当前这一版 DSH 的主题」里声明过 ---------------------
// 主题 token 会随 DSH 版本改名/删除（0.12.1 就把 state-danger-primary 换成了
// state-error-primary）。引用了不存在的 token，`var(--x, fallback)` 会静默退化成
// fallback——不报错、不崩溃，只是不再跟随主题，最难发现。所以这里对着真主题做比对。
const THEME_FILE = join(ASAR, '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js');
if (!existsSync(THEME_FILE)) {
  console.log('   (theme bundle not found, skipping token check)');
} else {
  const themeSource = readFileSync(THEME_FILE, 'utf8');
  const declared = new Set();
  for (const match of themeSource.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) declared.add(match[1]);
  const used = new Set();
  for (const match of source.matchAll(/--dsw-[a-z0-9-]+/g)) used.add(match[0]);
  const missing = [...used].filter((token) => !declared.has(token)).sort();
  console.log(`   theme tokens: ${declared.size} declared, ${used.size} used by client.js`);
  assert.deepEqual(missing, [], `client.js references theme tokens the current DSH theme does not declare: ${missing.join(', ')}`);
}

console.log('OK all dialog-fence render assertions passed');
