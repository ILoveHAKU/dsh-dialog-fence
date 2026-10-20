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
 * 这一步只保证 bundle 语法正确、产物形状正确、slot 注册参数正确；
 * 真正的视觉与交互需要重启 DSH 后在浏览器里看。
 *
 * 运行：
 *   node test/client.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT_FILE = join(import.meta.dirname, '..', 'client.js');

// ---- 假 React：只提供 client.js 实际用到的三个 API ---------------------------
const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
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

// ---- 假 document（ensureCss 会走一次） --------------------------------------
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
};

// ---- 执行 bundle -----------------------------------------------------------
const source = readFileSync(CLIENT_FILE, 'utf8');
const module = { exports: {} };
// bundle 是 CJS 风格（没有 import/export 语句），用 Function 包一层即可求值。
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

// ---- 3) apply() 只注册两个 slot，且参数正确 --------------------------------
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
assert.ok(styles[0].dataset.pluginCss, 'style tag is tagged for de-duplication');

assert.deepEqual(effects, ['dialog-fence: header', 'dialog-fence: overlay']);
assert.equal(injections, 2, 'both slots go through slots.inject (waits for declaration)');
assert.equal(registrations.length, 2);

const { spec: headerSpec, component: HeaderAction } = registrations[0];
assert.equal(headerSpec.name, 'conversation.session.header.utilities');
assert.equal(headerSpec.id, 'dialog-fence', 'uses its own slot id (never replaces a published id)');
assert.equal(typeof headerSpec.order, 'number');
assert.equal(typeof HeaderAction, 'function');

const { spec: overlaySpec, component: Panel } = registrations[1];
assert.equal(overlaySpec.name, 'shell.overlay');
assert.equal(overlaySpec.id, 'dialog-fence-panel');
assert.equal(typeof Panel, 'function');

// ---- 4) 组件能在「未读取到数据」与「有数据」两种状态下渲染而不抛 ---------------
const header_tree = HeaderAction({ sessionId: 'session-x' });
assert.equal(header_tree.type, 'button');
assert.equal(header_tree.props['data-on'], 'false');
assert.equal(header_tree.props.className, 'dialog-fence-trigger');

// Panel 在没打开任何会话时返回 null（浮层不占 DOM）
assert.equal(Panel(), null);

// ---- 5) 复算 dsh-client-modules 的解析链（保证重启后真能被扫到）-------------
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

console.log('OK all dialog-fence client bundle assertions passed');
console.log(`   bundle: ${pathToFileURL(CLIENT_FILE).href}`);
