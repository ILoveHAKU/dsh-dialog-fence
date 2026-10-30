/**
 * 单条规则启停测试（无宿主）。
 *
 * 契约（0.13.0 新增）：
 * - 存储侧 rules 仍然是**字符串数组**（老格式零迁移），单条启停位存在与之等长的
 *   并行布尔数组 ruleEnabled 上：`true` = 启用，缺省/越界一律视为启用。
 * - 新增规则默认启用 —— 用户原话「默认是配置以后就启用」。
 * - 注入只取启用的规则，编号按启用后的顺序连续，不出现空洞。
 * - 停用位必须跟着 remove / clear 一起平移，不能在删掉第 0 条之后错位。
 *
 * 跑法：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "D:\DSH Desktop\DSH Desktop.exe" test\ruletoggle.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENTRY = new URL('../index.js', import.meta.url).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-fence-ruletoggle-'));
process.env.DIALOG_FENCE_HOME = home;
process.env.DIALOG_FENCE_NO_OPEN = '1';
delete process.env.DIALOG_FENCE_FILE;

const failures = [];
function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

const routes = [];
const contexts = [];

const mod = await import(ENTRY);
await mod.apply({
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
    register() {
      return () => {};
    },
  },
  inject(names, callback) {
    const connection = {
      fetch: {
        register(spec) {
          routes.push(spec);
          return () => {};
        },
      },
    };
    return callback({ get: () => connection, effect: (fn) => fn() });
  },
  get() {
    return undefined;
  },
});

const route = routes[0];
const url = `http://127.0.0.1:43129${route.path}`;
const fenceFile = path.join(home, 'fence.json');

async function get(query = '') {
  const response = await route.fetch(new Request(`${url}${query}`, { method: 'GET' }));
  return { status: response.status, body: await response.json() };
}

async function post(payload) {
  const response = await route.fetch(new Request(url, { method: 'POST', body: JSON.stringify(payload) }));
  return { status: response.status, body: await response.json() };
}

/** 真实注入路径：走 systemPrompt.context 的 text 回调。 */
function injectFor(sessionId) {
  return contexts[0].text({ agent: { id: sessionId } });
}

function readJson() {
  return JSON.parse(fs.readFileSync(fenceFile, 'utf8'));
}

// ---------------------------------------------------------------------------
// 1) 通用规则：新增默认启用
// ---------------------------------------------------------------------------
{
  const added = await post({ action: 'add', scope: 'common', text: '规则甲' });
  check('通用层新增 200', added.status === 200, String(added.status));
  check('通用层新增后 rules[0].enabled 为 true', added.body.rules?.[0]?.enabled === true, JSON.stringify(added.body.rules));
  check('通用层新增后仍带 text', added.body.rules?.[0]?.text === '规则甲', JSON.stringify(added.body.rules));
  check('默认启用即注入', injectFor('s1').includes('规则甲'), injectFor('s1'));

  await post({ action: 'add', scope: 'common', text: '规则乙' });
}

// ---------------------------------------------------------------------------
// 2) 停用一条：不注入、编号不留空洞
// ---------------------------------------------------------------------------
{
  const off = await post({ action: 'toggleRule', scope: 'common', index: 0, enabled: false });
  check('停用第 1 条 200', off.status === 200, JSON.stringify(off.body));
  check('停用后 enabled=false', off.body.rules?.[0]?.enabled === false, JSON.stringify(off.body.rules));
  check('另一条保持启用', off.body.rules?.[1]?.enabled === true, JSON.stringify(off.body.rules));

  const text = injectFor('s1');
  check('停用的规则不注入', !text.includes('规则甲'), text);
  check('启用的规则照常注入', text.includes('规则乙'), text);
  check('编号从 1 连续、无空洞', text.includes('1. 规则乙') && !text.includes('2. 规则乙'), text);

  const snap = await get('?scope=common');
  check('快照 rendered 不含停用规则', !snap.body.rendered.includes('规则甲'), snap.body.rendered);
}

// ---------------------------------------------------------------------------
// 3) 再启用：恢复注入
// ---------------------------------------------------------------------------
{
  const on = await post({ action: 'toggleRule', scope: 'common', index: 0, enabled: true });
  check('启用第 1 条 200', on.status === 200, JSON.stringify(on.body));
  check('启用后 enabled=true', on.body.rules?.[0]?.enabled === true, JSON.stringify(on.body.rules));
  const text = injectFor('s1');
  check('重新启用后恢复注入', text.includes('规则甲') && text.includes('规则乙'), text);
}

// ---------------------------------------------------------------------------
// 4) 落盘：rules 仍是字符串数组，启停位是并行数组
// ---------------------------------------------------------------------------
{
  await post({ action: 'toggleRule', scope: 'common', index: 1, enabled: false });
  const parsed = readJson();
  check('rules 仍是字符串数组', Array.isArray(parsed.rules) && parsed.rules.every((item) => typeof item === 'string'), JSON.stringify(parsed.rules));
  check('规则文本未变', parsed.rules[0] === '规则甲' && parsed.rules[1] === '规则乙', JSON.stringify(parsed.rules));
  check('ruleEnabled 是等长布尔数组', Array.isArray(parsed.ruleEnabled) && parsed.ruleEnabled.length === parsed.rules.length, JSON.stringify(parsed.ruleEnabled));
  check('ruleEnabled 记录了停用位', parsed.ruleEnabled?.[0] === true && parsed.ruleEnabled?.[1] === false, JSON.stringify(parsed.ruleEnabled));
}

// ---------------------------------------------------------------------------
// 5) remove 之后停用位必须跟着平移
// ---------------------------------------------------------------------------
{
  const removed = await post({ action: 'remove', scope: 'common', index: 0 });
  check('删除第 1 条 200', removed.status === 200, JSON.stringify(removed.body));
  check('删后只剩规则乙', removed.body.rules?.length === 1 && removed.body.rules[0].text === '规则乙', JSON.stringify(removed.body.rules));
  check('停用位跟着平移', removed.body.rules?.[0]?.enabled === false, JSON.stringify(removed.body.rules));
  const parsed = readJson();
  check('落盘后 ruleEnabled 也平移', JSON.stringify(parsed.ruleEnabled) === JSON.stringify([false]), JSON.stringify(parsed.ruleEnabled));
}

// ---------------------------------------------------------------------------
// 6) clear 清空后不留残位
// ---------------------------------------------------------------------------
{
  await post({ action: 'clear', scope: 'common' });
  const parsed = readJson();
  check('clear 后 rules 空', Array.isArray(parsed.rules) && parsed.rules.length === 0, JSON.stringify(parsed.rules));
  check('clear 后 ruleEnabled 同步清空', Array.isArray(parsed.ruleEnabled) && parsed.ruleEnabled.length === 0, JSON.stringify(parsed.ruleEnabled));
}

// ---------------------------------------------------------------------------
// 7) 会话层同样支持单条启停
// ---------------------------------------------------------------------------
{
  const added = await post({ action: 'add', sessionId: 'session-toggle', text: '会话规则一' });
  check('会话层新增默认启用', added.body.rules?.[0]?.enabled === true, JSON.stringify(added.body.rules));
  await post({ action: 'add', sessionId: 'session-toggle', text: '会话规则二' });

  const off = await post({ action: 'toggleRule', sessionId: 'session-toggle', index: 0, enabled: false });
  check('会话层停用 200', off.status === 200, JSON.stringify(off.body));
  check('会话层停用生效', off.body.rules?.[0]?.enabled === false, JSON.stringify(off.body.rules));

  const text = injectFor('session-toggle');
  check('会话层停用的不注入', !text.includes('会话规则一'), text);
  check('会话层启用的仍注入', text.includes('会话规则二'), text);
  check('其它会话看不到该会话规则', !injectFor('session-other').includes('会话规则二'), injectFor('session-other'));

  const parsed = readJson();
  const entry = parsed.sessions['session-toggle'];
  check('会话层 ruleEnabled 落盘', Array.isArray(entry.ruleEnabled) && entry.ruleEnabled.length === entry.rules.length, JSON.stringify(entry));
  check('停用位已记录', entry.ruleEnabled?.[0] === false && entry.ruleEnabled?.[1] === true, JSON.stringify(entry.ruleEnabled));

  // update 改文本不应改变启停状态
  const updated = await post({ action: 'update', sessionId: 'session-toggle', index: 0, text: '会话规则一改' });
  check('update 保留停用状态', updated.body.rules?.[0]?.enabled === false, JSON.stringify(updated.body.rules));
  check('update 后文本已改', updated.body.rules?.[0]?.text === '会话规则一改', JSON.stringify(updated.body.rules));

  // 越界序号要报错
  const bad = await post({ action: 'toggleRule', sessionId: 'session-toggle', index: 9, enabled: false });
  check('越界 toggleRule 400', bad.status === 400, String(bad.status));
  check('越界 toggleRule 带 error', typeof bad.body.error === 'string' && bad.body.error.length > 0, JSON.stringify(bad.body));
}

// ---------------------------------------------------------------------------
// 8) 兼容：手写 JSON 没有 ruleEnabled 字段 = 全部启用
// ---------------------------------------------------------------------------
{
  const legacy = {
    version: 3,
    enabled: true,
    rules: ['老规则一', '老规则二'],
    sessions: { 'session-legacy': { enabled: true, rules: ['老会话规则'] } },
  };
  fs.writeFileSync(fenceFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const snap = await get('?scope=common');
  check('无字段时默认全部启用', snap.body.rules?.every((rule) => rule.enabled === true) === true, JSON.stringify(snap.body.rules));
  const text = injectFor('session-legacy');
  check('老数据照常注入通用规则', text.includes('老规则一') && text.includes('老规则二'), text);
  check('老数据照常注入会话规则', text.includes('老会话规则'), text);
  const sessionSnap = await get('?sessionId=session-legacy');
  check('会话快照里也默认启用', sessionSnap.body.rules?.every((rule) => rule.enabled === true) === true, JSON.stringify(sessionSnap.body.rules));
}

// ---------------------------------------------------------------------------
// 9) 全部规则都被停用时 = 不注入任何东西
// ---------------------------------------------------------------------------
{
  await post({ action: 'toggleRule', scope: 'common', index: 0, enabled: false });
  await post({ action: 'toggleRule', scope: 'common', index: 1, enabled: false });
  const text = injectFor('session-legacy');
  check('全部停用后不注入通用规则', !text.includes('老规则一') && !text.includes('老规则二'), text);
  check('会话规则仍照常注入', text.includes('老会话规则'), text);
  const snap = await get('?scope=common');
  check('全部停用时 rendered 为空', snap.body.rendered === '', JSON.stringify(snap.body.rendered));
  check('全部停用时 tokens 为 0', snap.body.tokens === 0, String(snap.body.tokens));
}

// ---------------------------------------------------------------------------
// 10) 快照字段：rules 保留 index / text，新增 enabled
// ---------------------------------------------------------------------------
{
  const snap = await get('?scope=common');
  const rule = snap.body.rules[0];
  check('快照保留 index', rule.index === 0, JSON.stringify(rule));
  check('快照保留 text', typeof rule.text === 'string' && rule.text.length > 0, JSON.stringify(rule));
  check('快照带 enabled 布尔', typeof rule.enabled === 'boolean', JSON.stringify(rule));
}

// 清理隔离目录（与 smoke.mjs:345 / route.mjs:315 保持一致，别在 %TEMP% 里留垃圾）。
fs.rmSync(home, { recursive: true, force: true });

if (failures.length === 0) {
  console.log('OK all dialog-fence per-rule toggle assertions passed');
} else {
  console.error(`FAIL: ${failures.length} 处不满足：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
