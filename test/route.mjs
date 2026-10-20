/**
 * HTTP 路由（可视化面板后端）的无宿主测试。
 *
 * 覆盖：GET 快照、POST toggle/add/update/remove/clear/reset、参数校验、
 * HEAD、非法 method、非法 sessionId、以及「没有 connection 服务时整段跳过」。
 *
 * 运行：
 *   node test/route.mjs          （或 ELECTRON_RUN_AS_NODE + DSH Desktop.exe）
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandboxDir = mkdtempSync(join(tmpdir(), 'dialog-fence-route-'));
process.env.DIALOG_FENCE_RULES = join(sandboxDir, 'rules.json');

const mod = await import(new URL('../index.js', import.meta.url).href);

const routes = [];
const contexts = [];
const commands = [];

function makeCtx({ withConnection = true } = {}) {
  const ctx = {
    effect(fn) {
      return fn();
    },
    systemPrompt: {
      context(spec) {
        contexts.push(spec);
        return () => {};
      },
    },
    commands: {
      register(spec) {
        commands.push(spec);
        return () => {};
      },
    },
    get(name) {
      if (name !== 'connection' || !withConnection) return undefined;
      return {
        fetch: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
      };
    },
  };
  return ctx;
}

// ---- 1) 有 connection 服务时：只注册一条 exact 路由 --------------------------
await mod.apply(makeCtx());
assert.equal(routes.length, 1, 'register exactly one fetch route');
const route = routes[0];
assert.equal(route.path, '/api/dialog-fence');
assert.deepEqual([...route.methods].sort(), ['GET', 'HEAD', 'POST']);
assert.equal(route.requestBody, 'buffered');
assert.equal(typeof route.fetch, 'function');

const base = 'http://127.0.0.1/api/dialog-fence';
const SESSION = `session-route-${Date.now()}`;
const get = (id) => route.fetch(new Request(`${base}?sessionId=${encodeURIComponent(id)}`, { method: 'GET' }));
const post = (body) =>
  route.fetch(
    new Request(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

// ---- 2) 未配置的会话：快照干净，零注入 --------------------------------------
let response = await get(SESSION);
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
let payload = await response.json();
assert.equal(payload.ok, true);
assert.equal(payload.enabled, false, 'unconfigured session is off');
assert.deepEqual(payload.rules, []);
assert.equal(payload.rendered, '', 'unconfigured session renders nothing');
assert.equal(payload.tokens, 0);
assert.ok(payload.limits.maxRules > 0);

// ---- 3) add 自动启用 --------------------------------------------------------
response = await post({ sessionId: SESSION, action: 'add', text: '不要修改本仓库以外的文件' });
assert.equal(response.status, 200);
payload = await response.json();
assert.equal(payload.enabled, true, 'add auto-enables');
assert.equal(payload.rules.length, 1);
assert.match(payload.rendered, /Dialog fence/, 'rendered text carries the fence header');
assert.match(payload.rendered, /不要修改/);
assert.equal(payload.chars, payload.rendered.length);
assert.ok(payload.tokens >= 1);

// ---- 4) 会话隔离：另一个会话仍然零注入 --------------------------------------
payload = await (await get('session-other')).json();
assert.equal(payload.enabled, false);
assert.equal(payload.rendered, '', 'other sessions stay untouched');

// ---- 5) update / remove / clear / toggle / reset ----------------------------
payload = await (await post({ sessionId: SESSION, action: 'update', index: 1, text: '规则已改' })).json();
assert.equal(payload.rules[0], '规则已改');
assert.match(payload.rendered, /规则已改/);

payload = await (await post({ sessionId: SESSION, action: 'add', text: '第二条' })).json();
assert.equal(payload.rules.length, 2);

payload = await (await post({ sessionId: SESSION, action: 'remove', index: 1 })).json();
assert.deepEqual(payload.rules, ['第二条']);

payload = await (await post({ sessionId: SESSION, action: 'toggle', enabled: false })).json();
assert.equal(payload.enabled, false);
assert.equal(payload.rendered, '', 'disabled session renders nothing');
assert.equal(payload.rules.length, 1, 'rules are kept while disabled');

payload = await (await post({ sessionId: SESSION, action: 'toggle', enabled: true })).json();
assert.equal(payload.rendered.length > 0, true);

payload = await (await post({ sessionId: SESSION, action: 'clear' })).json();
assert.deepEqual(payload.rules, []);
assert.equal(payload.rendered, '');

await post({ sessionId: SESSION, action: 'add', text: '待清理' });
payload = await (await post({ sessionId: SESSION, action: 'reset' })).json();
assert.equal(payload.enabled, false);
assert.equal(payload.rendered, '');

// ---- 6) 错误路径：必须是 400，且不能崩 --------------------------------------
assert.equal((await post({ sessionId: SESSION, action: 'unknown' })).status, 400, 'unknown action rejected');
assert.equal((await post({ sessionId: '', action: 'add', text: 'x' })).status, 400, 'empty sessionId rejected');
assert.equal((await post({ sessionId: 'a b', action: 'add', text: 'x' })).status, 400, 'whitespace sessionId rejected');
assert.equal((await post({ sessionId: SESSION, action: 'add', text: '' })).status, 400, 'empty rule rejected');
assert.equal(
  (await post({ sessionId: SESSION, action: 'add', text: 'x'.repeat(401) })).status,
  400,
  'over-long rule rejected',
);
assert.equal(
  (await post({ sessionId: SESSION, action: 'remove', index: 99 })).status,
  400,
  'out-of-range index rejected',
);
assert.equal(
  await Promise.resolve(
    route.fetch(
      new Request(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }),
    ),
  ).then((r) => r.status),
  400,
  'malformed JSON rejected',
);
assert.equal(
  (await route.fetch(new Request(base, { method: 'DELETE' }))).status,
  405,
  'unsupported method rejected',
);
assert.equal((await route.fetch(new Request(base, { method: 'GET' }))).status, 400, 'missing sessionId rejected');

// HEAD 探活
const head = await route.fetch(new Request(`${base}?sessionId=${SESSION}`, { method: 'HEAD' }));
assert.equal(head.status, 200);

// ---- 7) 没有 connection 服务（CLI / TUI / headless）：整段跳过，不抛 -------------
const cliRoutes = [];
const cliCtx = makeCtx({ withConnection: false });
cliCtx.get = () => undefined;
await mod.apply(cliCtx);
assert.equal(cliRoutes.length, 0);
assert.equal(contexts.length, 2, 'runtime context registered in both形态');
assert.equal(commands.length, 2, 'command registered in both形态');

// ---- 收尾 -------------------------------------------------------------------
rmSync(sandboxDir, { recursive: true, force: true });
console.log('OK all dialog-fence route assertions passed');
