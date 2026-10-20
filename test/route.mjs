/**
 * HTTP 路由（面板 / 插件页后端）的无宿主测试。
 *
 * 覆盖：GET 概览、GET 会话快照、POST toggleGlobal/toggle/add/update/remove/clear/reset、
 * 参数校验、HEAD、非法 method、非法 sessionId、以及「没有 connection 服务时整段跳过」。
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "D:\DSH Desktop\DSH Desktop.exe" "...\dialog-fence\test\route.mjs"
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandboxDir = mkdtempSync(join(tmpdir(), 'dialog-fence-route-'));
const dataDir = join(sandboxDir, 'rules');
process.env.DIALOG_FENCE_DIR = dataDir;

const mod = await import(new URL('../index.js', import.meta.url).href);

const routes = [];
const contexts = [];
const commands = [];

function makeCtx({ withConnection = true } = {}) {
  return {
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
    inject(names, callback) {
      if (!withConnection || !names.includes('connection')) return () => {};
      return callback({
        effect(fn) {
          return fn();
        },
        get(name) {
          if (name !== 'connection') return undefined;
          return {
            fetch: {
              register(route) {
                routes.push(route);
                return () => {};
              },
            },
          };
        },
      });
    },
    get() {
      return undefined;
    },
  };
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
const getSession = (id) => route.fetch(new Request(`${base}?sessionId=${encodeURIComponent(id)}`, { method: 'GET' }));
const getOverview = () => route.fetch(new Request(base, { method: 'GET' }));
const post = (body) =>
  route.fetch(
    new Request(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

// ---- 2) 概览（插件页）：无 sessionId 时返回全局状态 + 会话清单 -----------------
let response = await getOverview();
assert.equal(response.status, 200);
let payload = await response.json();
assert.equal(payload.ok, true);
assert.equal(payload.globalEnabled, true, 'global switch defaults to on');
assert.deepEqual(payload.sessions, [], 'no sessions configured yet');
assert.equal(payload.dataDir, dataDir);
assert.ok(payload.limits.maxRules > 0);

// ---- 3) 未配置的会话：快照干净，零注入 --------------------------------------
response = await getSession(SESSION);
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
payload = await response.json();
assert.equal(payload.ok, true);
assert.equal(payload.enabled, false, 'unconfigured session is off');
assert.deepEqual(payload.rules, []);
assert.equal(payload.rendered, '', 'unconfigured session renders nothing');
assert.equal(payload.tokens, 0);
assert.equal(payload.globalEnabled, true);
assert.ok(payload.dir.includes(SESSION), 'snapshot exposes the rule directory');

// ---- 4) add 自动启用，并且每条规则落地成一个 txt -----------------------------
response = await post({ sessionId: SESSION, action: 'add', text: '不要修改本仓库以外的文件' });
assert.equal(response.status, 200);
payload = await response.json();
assert.equal(payload.enabled, true, 'add auto-enables');
assert.equal(payload.rules.length, 1);
assert.equal(typeof payload.rules[0].file, 'string', 'each rule is addressable by file name');
assert.match(payload.rules[0].file, /^01-.*\.txt$/);
assert.equal(payload.rules[0].text, '不要修改本仓库以外的文件');
assert.match(payload.rendered, /Dialog fence/, 'rendered text carries the fence header');
assert.match(payload.rendered, /不要修改/);
assert.equal(payload.chars, payload.rendered.length);
assert.ok(payload.tokens >= 1);

const sessionDir = join(dataDir, 'sessions', SESSION);
assert.ok(existsSync(sessionDir), 'session rule directory created');
assert.equal(readdirSync(sessionDir).filter((f) => f.endsWith('.txt')).length, 1, 'one rule = one txt');

// 重复添加必须幂等（不产生第二个文件）
payload = await (await post({ sessionId: SESSION, action: 'add', text: '不要修改本仓库以外的文件' })).json();
assert.equal(payload.rules.length, 1, 'duplicate add is a no-op');
assert.equal(readdirSync(sessionDir).filter((f) => f.endsWith('.txt')).length, 1, 'no extra file for a duplicate');

// ---- 5) 会话隔离：另一个会话仍然零注入 --------------------------------------
payload = await (await getSession('session-other')).json();
assert.equal(payload.enabled, false);
assert.equal(payload.rendered, '', 'other sessions stay untouched');

// ---- 6) update / remove / clear / toggle / reset（按文件名寻址） --------------
const firstFile = payload.rules?.[0]?.file;
payload = await (
  await post({ sessionId: SESSION, action: 'update', file: firstFile ?? '01-rule.txt', text: '规则已改' })
).json();
assert.equal(payload.ok, true, `update worked: ${JSON.stringify(payload)}`);
assert.match(payload.rendered, /规则已改/);

payload = await (await post({ sessionId: SESSION, action: 'add', text: 'second rule' })).json();
assert.equal(payload.rules.length, 2);

const fileToRemove = payload.rules[0].file;
payload = await (await post({ sessionId: SESSION, action: 'remove', file: fileToRemove })).json();
assert.equal(payload.rules.length, 1, 'remove deleted exactly one rule');
assert.equal(readdirSync(sessionDir).filter((f) => f.endsWith('.txt')).length, 1, 'and exactly one file');

payload = await (await post({ sessionId: SESSION, action: 'toggle', enabled: false })).json();
assert.equal(payload.enabled, false);
assert.equal(payload.rendered, '', 'disabled session renders nothing');
assert.equal(payload.rules.length, 1, 'rules are kept while disabled');

payload = await (await post({ sessionId: SESSION, action: 'toggle', enabled: true })).json();
assert.ok(payload.rendered.length > 0);

payload = await (await post({ sessionId: SESSION, action: 'clear' })).json();
assert.deepEqual(payload.rules, []);
assert.equal(payload.rendered, '');
assert.equal(readdirSync(sessionDir).filter((f) => f.endsWith('.txt')).length, 0, 'clear deleted the files');

await post({ sessionId: SESSION, action: 'add', text: '待清理' });
payload = await (await post({ sessionId: SESSION, action: 'reset' })).json();
assert.equal(payload.enabled, false);
assert.equal(payload.rendered, '');

// ---- 7) 全局总开关（插件页）-------------------------------------------------
payload = await (await post({ action: 'toggleGlobal', enabled: false })).json();
assert.equal(payload.ok, true, 'toggleGlobal needs no sessionId');
assert.equal(payload.globalEnabled, false);

await post({ sessionId: SESSION, action: 'add', text: '全局关断时的规则' });
payload = await (await getSession(SESSION)).json();
assert.equal(payload.enabled, false, 'global off wins over the session switch');
assert.equal(payload.rendered, '', 'global off = zero injection everywhere');
assert.equal(payload.rules.length, 1, 'rules survive the global switch');

payload = await (await post({ action: 'toggleGlobal', enabled: true })).json();
assert.equal(payload.globalEnabled, true);
payload = await (await getSession(SESSION)).json();
assert.ok(payload.rendered.length > 0, 'turning the global switch back on restores injection');

// ---- 8) 错误路径：必须是 400，且不能崩 --------------------------------------
assert.equal((await post({ sessionId: SESSION, action: 'unknown' })).status, 400, 'unknown action rejected');
assert.equal((await post({ sessionId: '', action: 'add', text: 'x' })).status, 400, 'empty sessionId rejected');
assert.equal((await post({ sessionId: 'a/b', action: 'add', text: 'x' })).status, 200, 'path chars are sanitized, not fatal');
assert.equal((await post({ sessionId: SESSION, action: 'add', text: '' })).status, 400, 'empty rule rejected');
assert.equal(
  (await post({ sessionId: SESSION, action: 'add', text: 'x'.repeat(2001) })).status,
  400,
  'over-long rule rejected',
);
assert.equal(
  (await post({ sessionId: SESSION, action: 'add', text: 'x'.repeat(100) })).status,
  200,
  'a 100-char rule is fine',
);
assert.equal(
  (await post({ sessionId: SESSION, action: 'update', file: 'no-such-file.txt', text: 'y' })).status,
  400,
  'updating a missing file is rejected (never fabricates a rule)',
);
assert.equal(
  (await post({ sessionId: SESSION, action: 'remove', file: 'no-such-file.txt' })).status,
  400,
  'removing a missing file is rejected',
);
assert.equal(
  (await post({ sessionId: SESSION, action: 'remove' })).status,
  400,
  'remove without a file name is rejected',
);
assert.equal(
  await Promise.resolve(
    route.fetch(new Request(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })),
  ).then((r) => r.status),
  400,
  'malformed JSON rejected',
);
assert.equal((await route.fetch(new Request(base, { method: 'DELETE' }))).status, 405, 'unsupported method rejected');

// HEAD 探活
const head = await route.fetch(new Request(`${base}?sessionId=${SESSION}`, { method: 'HEAD' }));
assert.equal(head.status, 200);

// ---- 9) 没有 connection 服务（CLI / TUI / headless）：整段跳过，不抛 -------------
const cliCtx = makeCtx({ withConnection: false });
await mod.apply(cliCtx);
assert.equal(routes.length, 1, 'no extra route registered without the connection service');
assert.equal(contexts.length, 2, 'runtime context registered in both forms');
assert.equal(commands.length, 2, 'command registered in both forms');

// ---- 收尾 -------------------------------------------------------------------
rmSync(sandboxDir, { recursive: true, force: true });
console.log('OK all dialog-fence route assertions passed');
