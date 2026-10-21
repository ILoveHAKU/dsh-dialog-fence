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
const fakeSessions = {
  ids: [S1, S2],
  byId: {
    [S1]: {
      id: S1,
      displayTitle: 'SQL 邮件提醒遗漏排查',
      title: 'SQL 邮件提醒遗漏排查',
      retainedBy: { mainView: 1 },
      blank: false,
    },
    // 这一行没有标题、displayTitle 也已退化成 id —— 界面必须自己挡掉，改用「未命名对话」。
    [S2]: { id: S2, displayTitle: S2, retainedBy: {}, blank: true },
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

// ---- 4) 组合包详情页里的配置区（owner 只传 view: 'page'）---------------------
const bundleMarkup = renderToStaticMarkup(React.createElement(BundleConfig, { view: 'page' }));
assert.match(bundleMarkup, /class="dialog-fence-flat"/, 'bundle config renders the flat (no outer padding) variant');
assert.match(bundleMarkup, /总开关/, 'bundle config carries the global switch');
assert.match(bundleMarkup, /对话围栏/, 'bundle config shows the plugin title');

console.log('OK all dialog-fence render assertions passed');
