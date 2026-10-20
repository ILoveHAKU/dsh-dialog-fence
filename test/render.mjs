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

const ASAR = 'D:\\DSH Desktop\\resources\\app.asar\\node_modules';
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
assert.equal(registrations.length, 5, 'header + overlay + settings section + plugins tab + plugins item');
const HeaderAction = registrations[0].component;
const Panel = registrations[1].component;
const FencePage = registrations[2].component;
const PluginsTab = registrations[3].component;
const FenceItem = registrations[4].component;

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

// ---- 3) 配置页：首帧（overview 尚未返回）也要渲染总开关骨架 -------------------
const pageMarkup = renderToStaticMarkup(React.createElement(FencePage));
console.log(`   settings section: ${pageMarkup.slice(0, 160)}…`);
assert.match(pageMarkup, /class="dialog-fence-page"/, 'settings section renders its page container');
assert.match(pageMarkup, /对话围栏/, 'settings section shows the plugin title');
assert.match(pageMarkup, /总开关/, 'settings section exposes the global switch');
assert.match(pageMarkup, /开启围栏|关闭围栏/, 'global switch is actionable');
assert.doesNotMatch(pageMarkup, /读取中/, 'the settings section does not render a "loading" placeholder');
assert.doesNotMatch(pageMarkup, /<textarea/, 'no textarea anywhere');

// 插件页标签页复用同一个组件
const tabMarkup = renderToStaticMarkup(React.createElement(PluginsTab));
assert.match(tabMarkup, /class="dialog-fence-page"/, 'plugins tab renders its page container');

// ---- 4) plugins.item 的两种视图 --------------------------------------------
const summaryMarkup = renderToStaticMarkup(React.createElement(FenceItem, { view: 'summary' }));
console.log(`   plugins item summary: ${summaryMarkup}`);
assert.match(summaryMarkup, /对话边界规则/, 'summary is a one-liner describing the fence');
assert.doesNotMatch(summaryMarkup, /dialog-fence-card/, 'summary view stays on one line');

const itemPageMarkup = renderToStaticMarkup(React.createElement(FenceItem, { view: 'page' }));
assert.match(itemPageMarkup, /class="dialog-fence-flat"/, 'page view renders the flat config UI');
assert.match(itemPageMarkup, /总开关/, 'page view carries the global switch');

console.log('OK all dialog-fence render assertions passed');
