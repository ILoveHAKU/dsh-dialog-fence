/**
 * 浏览器半边（client.js）的无浏览器测试。
 *
 * client.js 的形态是懒 CJS 工厂：执行文件本体只调用
 * window.__ModuleLoader__.load({ id, factory }) 注册工厂，不产生副作用；
 * 真正的模块体在 factory(require) 里。所以这里可以：
 *   1. 造一个假的 window.__ModuleLoader__ 接住 load() 调用；
 *   2. 用一个只认 "react" 的假 require 调 factory；
 *   3. 检查导出的 apply / inject 形态，并用假 ctx 跑一遍 apply。
 *
 * 0.3.0 起有三处界面：会话头部按钮、浮层面板、插件页（settings.plugins.tab）。
 * 0.4.0 起再加两处：设置左栏一级菜单（settings.section）、插件页官方分组卡片（plugins.item）。
 * 0.5.0 起 plugins.item 换成 plugins.bundle.config（组合包详情页里的配置区）。
 *
 * 这一步只保证 bundle 语法正确、产物形状正确、slot 注册参数正确；
 * 真正的视觉与交互需要重启 DSH 后在浏览器里看。
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "D:\DSH Desktop\DSH Desktop.exe" "...\dialog-fence\test\client.mjs"
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT_FILE = join(import.meta.dirname, '..', 'client.js');

// ---- 假 React：只提供 client.js 实际用到的 API -------------------------------
// useEffect 会**真的执行**：浮层的「点外部关闭」是靠 document 监听实现的，
// 不跑 effect 就永远测不到它（只能靠正则去猜源码）。这里把 cleanup 收起来，
// 顺便也能验证「监听器随组件卸载被摘掉、不会泄漏」。
const effectCleanups = [];
const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect(callback) {
    const cleanup = callback();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  },
};

// ---- 假 window.__ModuleLoader__ --------------------------------------------
const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition);
    },
  },
};

// ---- 假 document（ensureCss 会走一次；mousedown 监听要能装、能摘） ------------
// 「点外部关闭」完全依赖 document 级监听，所以这里必须真的记录注册表：
// 装了几次、摘了几次、回调能不能被触发，都要可观察。
const listeners = new Map();
const styles = [];
globalThis.document = {
  querySelector() {
    return null;
  },
  createElement(tag) {
    return { tag, dataset: {}, textContent: '' };
  },
  head: {
    appendChild(node) {
      styles.push(node);
    },
  },
  addEventListener(type, callback, capture) {
    const key = `${type}:${capture === true ? 'capture' : 'bubble'}`;
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(callback);
  },
  removeEventListener(type, callback, capture) {
    const key = `${type}:${capture === true ? 'capture' : 'bubble'}`;
    listeners.get(key)?.delete(callback);
  },
  /** 模拟一次点击，按捕获阶段的真实顺序调用所有监听器。 */
  fireMousedown(target) {
    for (const callback of [...(listeners.get('mousedown:capture') ?? [])]) callback({ target });
  },
};

// 渲染期不该联网；动作函数只会在事件里被调用，测试不触发。
const fetched = [];
globalThis.fetch = async (url, init) => {
  fetched.push({ url: String(url), init });
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, globalEnabled: true, sessions: [] };
    },
  };
};

// ---- 执行 bundle -----------------------------------------------------------
const source = readFileSync(CLIENT_FILE, 'utf8');
const module = { exports: {} };
new Function('window', 'document', 'module', 'exports', source)(
  globalThis.window,
  globalThis.document,
  module,
  module.exports,
);

// ---- 1) 只注册了一个模块，id 与包名一致 -------------------------------------
assert.equal(loaded.length, 1, 'bundle registers exactly one module');
const definition = loaded[0];
assert.equal(definition.id, 'dsh-dialog-fence', 'module id is the package name');
assert.equal(typeof definition.factory, 'function');

// ---- 2) 工厂只依赖 react，导出 apply / inject ------------------------------
const requested = [];
const exportsObject = definition.factory((specifier) => {
  requested.push(specifier);
  if (specifier === 'react') return react;
  throw new Error(`unexpected require("${specifier}")`);
});

assert.deepEqual(requested, ['react'], 'client bundle requires nothing but react');
assert.equal(typeof exportsObject.apply, 'function');
assert.deepEqual(exportsObject.inject, ['slots']);

// ---- 3) apply() 注册五处界面，且参数正确 -----------------------------------
const registrations = [];
let injections = 0;
const effects = [];
const ctx = {
  effect(fn, label) {
    effects.push(label);
    return fn();
  },
  slots: {
    inject(name, callback) {
      injections += 1;
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    register(spec, component) {
      registrations.push({ spec, component });
      return () => {};
    },
  },
};

exportsObject.apply(ctx);

assert.equal(styles.length, 1, 'injects exactly one <style> tag');
assert.match(styles[0].textContent, /dialog-fence-trigger/, 'css covers the trigger button');
assert.match(styles[0].textContent, /\.dialog-fence-page/, 'css covers the plugins page');
assert.match(styles[0].textContent, /\.dialog-fence-input/, 'css covers the fence-file path input');
assert.match(styles[0].textContent, /\.dialog-fence-textarea/, 'css covers the multiline rule editor');
assert.match(styles[0].textContent, /resize:vertical/, 'the rule editor is resizable');
assert.ok(styles[0].dataset.pluginCss, 'style tag is tagged for de-duplication');

assert.deepEqual(effects, [
  'dialog-fence: header',
  'dialog-fence: overlay',
  'dialog-fence: settings-section',
  'dialog-fence: plugins-tab',
  'dialog-fence: bundle-config',
]);
assert.equal(injections, 5, 'all slots go through slots.inject (waits for declaration)');
assert.equal(registrations.length, 5);

const { spec: headerSpec, component: HeaderAction } = registrations[0];
assert.equal(headerSpec.name, 'conversation.session.header.utilities');
assert.equal(headerSpec.id, 'dialog-fence', 'uses its own slot id (never replaces a published id)');
assert.equal(typeof headerSpec.order, 'number');
assert.equal(typeof HeaderAction, 'function');

const { spec: overlaySpec, component: Panel } = registrations[1];
assert.equal(overlaySpec.name, 'shell.overlay');
assert.equal(overlaySpec.id, 'dialog-fence-panel');
assert.equal(typeof Panel, 'function');

// 设置左栏一级菜单项（用户 CR-06 要的位置：设置 → 对话围栏）
const { spec: sectionSpec, component: FencePage } = registrations[2];
assert.equal(sectionSpec.name, 'settings.section', 'appears in the Settings left nav');
assert.equal(sectionSpec.id, 'dialog-fence', 'own section id, adds a nav row instead of replacing one');
assert.equal(typeof sectionSpec.order, 'number');
assert.equal(typeof sectionSpec.label, 'function', 'label is a thunk so it follows the locale');
assert.equal(sectionSpec.label(), '对话围栏');
assert.equal(typeof FencePage, 'function');

const { spec: tabSpec, component: PluginTab } = registrations[3];
assert.equal(tabSpec.name, 'settings.plugins.tab', 'appears in the Plugins settings section');
assert.equal(tabSpec.id, 'dialog-fence', 'own tab id, adds a cell instead of replacing one');
assert.equal(typeof tabSpec.order, 'number');
assert.equal(typeof tabSpec.label, 'function', 'label is a thunk so it follows the locale');
assert.equal(tabSpec.label(), '对话围栏');
assert.equal(typeof PluginTab, 'function');

// 「插件」页 → 已安装 → 本组合包详情页里的配置区
const { spec: bundleSpec, component: BundleConfig } = registrations[4];
assert.equal(bundleSpec.name, 'plugins.bundle.config', 'renders inside the bundle detail page');
assert.equal(bundleSpec.key, 'dsh-dialog-fence', 'keyed by the bundle package name');
assert.equal(typeof BundleConfig, 'function');

// ---- 4) 组件能在「未读取到数据」与「有数据」两种状态下渲染而不抛 ---------------
const headerTree = HeaderAction({ sessionId: 'session-x' });
assert.equal(headerTree.type, 'button');
assert.equal(headerTree.props['data-on'], 'false');
assert.equal(headerTree.props.className, 'dialog-fence-trigger');

// Panel 在没打开任何会话时返回 null（浮层不占 DOM）
assert.equal(Panel(), null);

// 配置页第一帧（还没拉到快照）也要能渲染
const sectionTree = FencePage();
assert.equal(sectionTree.type, 'div');
assert.equal(sectionTree.props.className, 'dialog-fence-page');

// 设置页的主视图必须是「可直接编辑的规则列表」，不是会话清单。
// 假 React 的 useState 返回初值、useEffect 不执行，所以这里只能看首帧骨架：
// 但「会话表」的结构（.dialog-fence-table / .dialog-fence-tr）必须彻底消失。
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  collectText(node.children, out);
  return out;
}
function collectClass(node, out = new Set()) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectClass(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (typeof node.props?.className === 'string') out.add(node.props.className);
  collectClass(node.children, out);
  return out;
}
const sectionText = collectText(sectionTree).join(' ');
const sectionClasses = collectClass(sectionTree);
assert.match(sectionText, /围栏规则（对每个对话生效）/, 'the rule editor is the main view of the settings page');
assert.match(sectionText, /读取中/, 'first frame shows the loading placeholder for the common layer');
assert.ok(sectionClasses.has('dialog-fence-textarea'), 'the page offers a multiline box for a new rule');
assert.equal(sectionClasses.has('dialog-fence-table'), false, 'the session table is gone');
assert.equal(sectionClasses.has('dialog-fence-tr'), false, 'no per-session rows on the settings page');

// 组合包详情页传入的是 { view: 'page' }，此时用紧凑版式（详情页自己有标题与留白）
const bundleTree = BundleConfig({ view: 'page' });
assert.equal(bundleTree.type, 'div');
assert.equal(bundleTree.props.className, 'dialog-fence-flat', 'page view inside a detail page drops the outer padding');

// ---- 4.5) 0.7.0：单文件 JSON + 打开文件夹 + 自定义位置 ----------------------
// 设置页与浮层面板都要有「打开文件夹」，设置页还要能改文件位置。
assert.match(sectionText, /打开文件夹/, 'settings page offers a button that reveals the fence file');
assert.match(sectionText, /更改位置/, 'settings page lets the user move the fence file');
assert.match(source, /act\(undefined, 'openFolder'\)/, 'the open-folder button posts the openFolder action');
assert.match(source, /act\(undefined, 'setFile', \{ file: target \}\)/, 'moving the file posts the setFile action');

// 规则增删改一律按**序号**（单文件 JSON 里没有文件名这回事）
assert.match(source, /act\(COMMON_SCOPE, 'update', \{ index: target, text \}\)/, 'common rules are updated by index');
assert.match(source, /act\(COMMON_SCOPE, 'remove', \{ index: target \}\)/, 'common rules are removed by index');
assert.match(source, /onSave\(rule\.index, text\)/, 'RuleRow reports the rule index, not a file name');
assert.doesNotMatch(source, /onSave\(rule\.file/, 'RuleRow no longer passes a file name around');

// 用户 CR-14 第 1 条：右上角按钮打开后要同步出现配置。
// 面板挂载（含 openSessionId 变化）时必须同时拉本会话与通用层，否则设置页里刚改的规则不会出现。
assert.match(source, /refreshAll\(\)/, 'the panel pulls the shared rule layer so it agrees with the settings page');
assert.match(source, /if \(sessionId !== null\) \{\s*refresh\(sessionId\);\s*refreshAll\(\);/, 'opening the panel refreshes both the session and the common layer');
assert.match(sectionText, /围栏规则（对每个对话生效）/, 'the panel shows the shared rules, not only the per-session ones');

// 徽标数字必须是真实注入条数（通用 + 专属），否则配了 10 条通用规则时按钮还显示「1」，看着像没生效。
assert.match(source, /const commonCount = common\?\.rules\?\.length \?\? 0;/, 'header badge counts the shared layer');
assert.match(source, /const count = commonCount \+ sessionCount;/, 'header badge is shared + per-session, matching what is injected');

// ---- 4.6) 0.8.0：「打开文件夹」必须把结果说出来 ----------------------------
// 缺陷：act() 以前把 openFolder 的回包当成普通概览丢掉，opened/openReason/openWarning 全不读，
// 于是「成功」「失败」「被系统拦掉」在界面上完全一样 —— 用户只会觉得点了没反应。
assert.match(source, /function noticeOf\(snapshot\)/, 'openFolder results are translated into a message');
assert.match(source, /notice: noticeOf\(snapshot\)/, 'act() stores the openFolder message');
assert.match(source, /snapshot\.opened === false/, 'the client reads opened from the response');
assert.match(source, /snapshot\.openWarning/, 'the client surfaces the deferred spawn failure');
assert.match(source, /'data-notice': 'open-folder'/, 'the settings page renders the notice');
// 三条结果必须能区分开
assert.match(source, /'已打开围栏文件夹'/, 'success is stated explicitly');
assert.match(source, /'测试模式：没有真的打开窗口'/, 'test-mode is reported, not silently ignored');
assert.match(source, /上一次启动资源管理器失败/, 'a deferred spawn failure is reported');

// ---- 5) 规则正文用多行输入框（0.9.0，用户 CR-16：单行 input 不好调整内容）----
// 每条规则的编辑器、以及三处「新建规则」框都必须是 textarea：
// 规则是成句成段的中文，单行 input 看不全也换不了行。
assert.match(source, /createElement\(\s*'textarea'/, 'rule editors use a multiline textarea');
assert.match(source, /dialog-fence-textarea/, 'the textarea carries its own class');
assert.equal(
  (source.match(/createElement\('textarea'/g) ?? []).length,
  5,
  'five textareas: 1 rule editor + 4 new-rule boxes (panel common, panel session, settings common, settings session)',
);
// 唯一还该用单行 input 的地方是「围栏文件绝对路径」——路径含换行没有意义。
assert.equal(
  (source.match(/className: 'dialog-fence-input'/g) ?? []).length,
  1,
  'the only remaining single-line input is the fence-file path box',
);
assert.equal(
  (source.match(/createElement\('textarea'/g) ?? []).length,
  5,
  'five textareas: 1 rule editor + 4 new-rule boxes (panel common, panel session, settings common, settings session)',
);
// 多行框里 Enter 必须换行，提交改走 Ctrl/Cmd+Enter。
assert.match(
  source,
  /event\.key === 'Enter' && \(event\.ctrlKey === true \|\| event\.metaKey === true\)/,
  'Enter inserts a newline; Ctrl/Cmd+Enter commits',
);
assert.doesNotMatch(source, /if \(event\.key === 'Enter'\) commit\(\);/, 'bare Enter no longer commits the rule editor');
// 仍然没有「打开就变成长文本框」的老毛病：查看态是纯文本，只有点「改」才出编辑器。
assert.match(source, /className: 'dialog-fence-text' \}, rule\.text/, 'idle rows stay plain text');
assert.match(source, /if \(!editing\)/, 'the editor only appears while editing');

// ---- 5.5) 设置页补上「专属规则」编辑区 + 会话下拉（显示名称，不显示 id）------
// 缺陷（用户 CR-17 第 1 条）：设置页第三张卡过去只有两句说明文字，
// 让用户「去右上角浮层里改」，两处界面不同步。现在两边共用同一份数据与同一套动作。
assert.match(
  source,
  /function sessionLabelOf\(row, index\)/,
  'a conversation gets a human label derived from its title',
);
assert.match(
  source,
  /return `未命名对话 \$\{index \+ 1\}`;/,
  'a conversation without a title falls back to a readable name, never its id',
);
assert.match(
  source,
  /function currentSessionIdOf\(list\)/,
  'the page can recognise the conversation being viewed',
);
assert.match(
  source,
  /retained\?\.mainView/,
  'current conversation is detected by retainedBy.mainView, same rule as the workspace sidebar',
);
assert.match(
  source,
  /props\?\.useSessions/,
  'the conversation names come from the slot standardProp useSessions',
);
assert.match(source, /className: 'dialog-fence-select'/, 'the picker is a <select>, so it cannot be mistaken for a text box');
assert.match(
  source,
  /`\$\{choice\.label\}（当前）`/,
  'the current conversation is marked in the picker',
);
assert.match(
  source,
  /act\(targetSession, 'add', \{ text \}\)/,
  'the settings page posts per-conversation adds against the selected conversation',
);
assert.match(
  source,
  /act\(targetSession, 'update', \{ index: target, text \}\)/,
  'per-conversation edits from the settings page go by index',
);
assert.match(
  source,
  /act\(targetSession, 'remove', \{ index: target \}\)/,
  'per-conversation deletes from the settings page go by index',
);
assert.doesNotMatch(
  source,
  /点那个对话右上角的「围栏」按钮/,
  'the read-only hint that pushed users to the overlay is gone',
);

// ---- 5.6) 浮层点外部自动关闭 ------------------------------------------------
// 两个必须排除的落点：面板内部（否则改规则时自己就关了）与头部触发按钮
// （否则 mousedown 先关、onClick 又按 isOpen=false 打开，面板永远关不掉）。
assert.match(source, /addEventListener\('mousedown', onPointerDown, true\)/, 'an outside mousedown closes the panel');
assert.match(
  source,
  /removeEventListener\('mousedown', onPointerDown, true\)/,
  'the listener is removed on unmount, so it cannot leak',
);
assert.match(source, /target\.closest\('\.dialog-fence-panel'\) !== null\) return;/, 'clicks inside the panel do not close it');
assert.match(
  source,
  /target\.closest\('\.dialog-fence-trigger'\) !== null\) return;/,
  'clicks on the header trigger are left to its own onClick, otherwise the panel reopens immediately',
);
assert.match(source, /patch\(\{ openSessionId: null \}\)/, 'an outside click really closes the overlay');

// ---- 5.7) 点外部关闭：真的触发一次 mousedown，看面板到底关没关 ---------------
// 上面的正则只能证明「源码里有这行」；这里让假 React 真的跑 effect，
// 再往 document 上打一次点击，验证四种落点的实际结果。
function fakeTarget(...classes) {
  const set = new Set(classes);
  return {
    closest(selector) {
      const name = selector.replace(/^\./, '');
      return set.has(name) ? { className: name } : null;
    },
  };
}

// 先打开面板：点头部按钮就是真实的开合入口。
assert.equal(Panel(), null, 'panel starts closed');
HeaderAction({ sessionId: 'session-x' }).props.onClick();
const openTree = Panel();
assert.notEqual(openTree, null, 'clicking the header button opens the panel');
assert.equal(openTree.props.className, 'dialog-fence-panel');
assert.equal((listeners.get('mousedown:capture') ?? new Set()).size, 1, 'an open panel watches the document once');

// 点面板内部：不能关（否则一改规则就把自己关掉）。
document.fireMousedown(fakeTarget('dialog-fence-panel'));
assert.notEqual(Panel(), null, 'a click inside the panel leaves it open');
// 点头部「围栏」按钮：交给它自己的 onClick，这里不能抢先关。
document.fireMousedown(fakeTarget('dialog-fence-trigger'));
assert.notEqual(Panel(), null, 'a click on the header trigger does not close it (its own onClick decides)');
// 点无关的地方：必须关。
document.fireMousedown(fakeTarget('some-unrelated-area'));
assert.equal(Panel(), null, 'a click anywhere else closes the panel');
// 关闭后监听器必须被摘掉，否则页面上留一个永不释放的 document 监听。
effectCleanups.forEach((cleanup) => cleanup());
assert.equal(
  (listeners.get('mousedown:capture') ?? new Set()).size,
  0,
  'the document listener is removed on unmount',
);

// ---- 6) 复算 dsh-client-modules 的解析链（保证重启后真能被扫到）-------------
// 参考 dsh-client-modules/lib/index.js：
//   locatePkgJson(pathLike) → nearestPackage(moduleUrl) → 读 dsh.client
//   → platform 必须 'web' → exports["./client"] 解出 bundle 路径 → 文件必须存在
const PLUGIN_DIR = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));

function clientExportOf(pkgName, exportsField) {
  const field = exportsField?.['./client'];
  if (typeof field === 'string') return field;
  if (typeof field?.default === 'string') return field.default;
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}

assert.equal(typeof pkg.dsh?.client?.platform, 'string', 'dsh.client.platform is declared');
assert.equal(pkg.dsh.client.platform, 'web', 'declares the web platform');
assert.ok(Array.isArray(pkg.dsh.client.inject ?? []), 'dsh.client.inject is a string array when present');
for (const name of pkg.dsh.client.inject ?? []) assert.equal(typeof name, 'string');

const clientRel = clientExportOf(pkg.name, pkg.exports);
assert.equal(clientRel, './client.js');
assert.ok(existsSync(join(PLUGIN_DIR, clientRel)), 'exports["./client"] points at a file that exists');

// bundle 图的 id 就是 package.json 的 name，服务 URL 由它拼出来。
assert.equal(pkg.name, definition.id, 'package name matches the module-loader id');
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'declares a bundle patch for dsh plugin add');
assert.ok(existsSync(join(PLUGIN_DIR, pkg.dsh.bundle.patch)), 'bundle patch file exists');

// 插件页要显示标题/描述，metaOf 读的是 package.json 的 name/description。
assert.equal(typeof pkg.description, 'string', 'package.json carries a description for the plugins page');
assert.ok(pkg.description.length > 0, 'description is non-empty');

// ---- 7) 兼容性声明必须是「DSH 真正会读的那个字段」-----------------------------
// dsh-app-boot/lib/index.js:279 unmetRequirements()：只看 engines.dsh；没有它才退回
// peerDependencies 里的 @deepseek-ai/dsh*。dsh.compatibility.dshReleases 在全 asar
// 里 0 命中 —— 是死字段，写了也等于没写（0.12.1 实测）。
assert.equal(typeof pkg.engines?.dsh, 'string', 'engines.dsh is declared (the only field DSH reads)');
assert.ok(pkg.engines.dsh.trim().length > 0, 'engines.dsh is not empty');
assert.equal(pkg.dsh?.compatibility, undefined, 'no dead dsh.compatibility.dshReleases field');

console.log('OK all dialog-fence client bundle assertions passed');
console.log(`   bundle: ${pathToFileURL(CLIENT_FILE).href}`);
