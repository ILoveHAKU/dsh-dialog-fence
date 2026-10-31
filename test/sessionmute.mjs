/**
 * 「哪些对话不使用围栏」名单测试（无宿主）。
 *
 * 契约（0.14.0 新增，用户 CR-22）：
 * - 顶层并行字段 mutedSessions: string[] 记录**不使用围栏**的会话 id；
 *   缺字段 / 空数组 = 所有对话都使用围栏（默认不豁免，与以前完全一样）。
 * - 名单内的会话：fenceTextFor() 返回空串 —— 通用规则与专属规则都不注入，
 *   不是「只关专属规则」。这是用户要的「对哪些会话不再使用围栏规则」。
 * - 名单只影响注入，不动该会话已配置的规则，取消豁免后原样恢复。
 * - 支持一次提交多个会话（多选），也支持单个。
 * - 会话 id 一律过 sanitizeSessionId；空串直接忽略。
 *
 * 跑法：
 *   node test/sessionmute.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENTRY = new URL('../index.js', import.meta.url).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-fence-sessionmute-'));
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

/** 名单取值统一走它：旧实现缺字段时不能把测试自己搞崩。 */
function listOf(body) {
  return Array.isArray(body?.mutedSessions) ? body.mutedSessions : [];
}

// ---------------------------------------------------------------------------
// 1) 默认：没有名单 = 所有对话都使用围栏
// ---------------------------------------------------------------------------
{
  await post({ action: 'add', scope: 'common', text: '通用规则甲' });
  await post({ action: 'add', sessionId: 'session-mute-a', text: '甲专属规则' });

  const overview = await get();
  check('默认 mutedSessions 是空数组', listOf(overview.body).length === 0, JSON.stringify(overview.body.mutedSessions));
  const snapA = await get('?sessionId=session-mute-a');
  check('默认该会话未被豁免', snapA.body.muted === false, JSON.stringify(snapA.body.muted));
  const text = injectFor('session-mute-a');
  check('默认照常注入通用规则', text.includes('通用规则甲'), text);
  check('默认照常注入专属规则', text.includes('甲专属规则'), text);
}

// ---------------------------------------------------------------------------
// 2) 豁免一个会话：通用层与专属层都不注入，其它会话不受影响
// ---------------------------------------------------------------------------
{
  const muted = await post({ action: 'mute', sessions: ['session-mute-a'], muted: true });
  check('豁免请求 200', muted.status === 200, JSON.stringify(muted.body));
  check('概览里出现该会话', listOf(muted.body).includes('session-mute-a'), JSON.stringify(muted.body.mutedSessions));

  const text = injectFor('session-mute-a');
  check('豁免后不注入通用规则', !text.includes('通用规则甲'), text);
  check('豁免后不注入专属规则', !text.includes('甲专属规则'), text);
  check('豁免后注入文本为空', text === '', JSON.stringify(text));

  const other = injectFor('session-mute-b');
  check('其它会话仍注入通用规则', other.includes('通用规则甲'), other);

  const snap = await get('?sessionId=session-mute-a');
  check('会话快照标记 muted', snap.body.muted === true, JSON.stringify(snap.body.muted));
  check('会话快照 rendered 为空', snap.body.rendered === '', JSON.stringify(snap.body.rendered));
  check('会话快照 tokens 为 0', snap.body.tokens === 0, String(snap.body.tokens));
  check('豁免不清空该会话已配的规则', Array.isArray(snap.body.rules) && snap.body.rules.length === 1, JSON.stringify(snap.body.rules));
}

// ---------------------------------------------------------------------------
// 3) 落盘形状：mutedSessions 是字符串数组，rules 仍是字符串数组
// ---------------------------------------------------------------------------
{
  const parsed = readJson();
  check('落盘 mutedSessions 是数组', Array.isArray(parsed.mutedSessions), JSON.stringify(parsed.mutedSessions));
  check('落盘记录了该会话', listOf(parsed).includes('session-mute-a'), JSON.stringify(parsed.mutedSessions));
  check('落盘 rules 仍是字符串数组', Array.isArray(parsed.rules) && parsed.rules.every((item) => typeof item === 'string'), JSON.stringify(parsed.rules));
  check('落盘 version 仍是 3', parsed.version === 3, String(parsed.version));
  check('会话规则原样保留', JSON.stringify(parsed.sessions['session-mute-a'].rules) === JSON.stringify(['甲专属规则']), JSON.stringify(parsed.sessions['session-mute-a']));
}

// ---------------------------------------------------------------------------
// 4) 多选：一次提交多个会话
// ---------------------------------------------------------------------------
{
  const many = await post({ action: 'mute', sessions: ['session-mute-b', 'session-mute-c'], muted: true });
  check('多选豁免 200', many.status === 200, JSON.stringify(many.body));
  const list = listOf(many.body);
  check('多选都进名单', ['session-mute-a', 'session-mute-b', 'session-mute-c'].every((id) => list.includes(id)), JSON.stringify(many.body.mutedSessions));
  check('多选后 b 不注入', injectFor('session-mute-b') === '', JSON.stringify(injectFor('session-mute-b')));
  check('多选后 c 不注入', injectFor('session-mute-c') === '', JSON.stringify(injectFor('session-mute-c')));
  const parsed = readJson();
  check('名单有序（便于比对与去重）', JSON.stringify(listOf(parsed)) === JSON.stringify([...listOf(parsed)].sort()), JSON.stringify(parsed.mutedSessions));
  check('重复提交不产生重复项', new Set(listOf(parsed)).size === listOf(parsed).length, JSON.stringify(parsed.mutedSessions));
}

// ---------------------------------------------------------------------------
// 5) 取消豁免：原样恢复注入
// ---------------------------------------------------------------------------
{
  const back = await post({ action: 'mute', sessions: ['session-mute-a'], muted: false });
  check('取消豁免 200', back.status === 200, JSON.stringify(back.body));
  check('名单里移除该会话', !listOf(back.body).includes('session-mute-a'), JSON.stringify(back.body.mutedSessions));
  const text = injectFor('session-mute-a');
  check('取消后恢复注入通用规则', text.includes('通用规则甲'), text);
  check('取消后恢复注入专属规则', text.includes('甲专属规则'), text);
}

// ---------------------------------------------------------------------------
// 6) 非法会话 id 一律忽略，不写进名单
// ---------------------------------------------------------------------------
{
  const dirty = await post({ action: 'mute', sessions: ['', '   ', 'bad id/../x', 'session ok'], muted: true });
  check('脏输入 200', dirty.status === 200, JSON.stringify(dirty.body));
  const list = listOf(dirty.body);
  check('空串不进名单', !list.includes(''), JSON.stringify(dirty.body.mutedSessions));
  check('空白串不进名单', !list.includes('   '), JSON.stringify(dirty.body.mutedSessions));
  check('穿越串被消毒后进名单', list.some((id) => id.startsWith('bad_id')), JSON.stringify(dirty.body.mutedSessions));
  check('含空格串被消毒后进名单', list.some((id) => id.startsWith('session') && id.includes('_')), JSON.stringify(dirty.body.mutedSessions));
  check('名单里没有斜杠', list.every((id) => !id.includes('/')), JSON.stringify(dirty.body.mutedSessions));
}

// ---------------------------------------------------------------------------
// 7) 兼容：手写 JSON 没有 mutedSessions 字段 = 所有对话都使用围栏
// ---------------------------------------------------------------------------
{
  const legacy = {
    version: 3,
    enabled: true,
    rules: ['老规则一'],
    sessions: { 'session-legacy': { enabled: true, rules: ['老会话规则'] } },
  };
  fs.writeFileSync(fenceFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  const snap = await get('?sessionId=session-legacy');
  check('老文件默认不豁免', snap.body.muted === false, JSON.stringify(snap.body.muted));
  const text = injectFor('session-legacy');
  check('老文件照常注入', text.includes('老规则一') && text.includes('老会话规则'), text);
  const overview = await get();
  check('老文件概览 mutedSessions 为空', listOf(overview.body).length === 0, JSON.stringify(overview.body.mutedSessions));
}

// ---------------------------------------------------------------------------
// 8) 总开关关掉时，豁免名单不影响「一律不注入」
// ---------------------------------------------------------------------------
{
  await post({ action: 'mute', sessions: ['session-legacy'], muted: true });
  await post({ action: 'toggleGlobal', enabled: false });
  check('总开关关 + 豁免 = 不注入', injectFor('session-legacy') === '', JSON.stringify(injectFor('session-legacy')));
  await post({ action: 'toggleGlobal', enabled: true });
  check('总开关开 + 豁免 = 仍不注入', injectFor('session-legacy') === '', JSON.stringify(injectFor('session-legacy')));
  await post({ action: 'mute', sessions: ['session-legacy'], muted: false });
  check('取消豁免后恢复', injectFor('session-legacy').includes('老规则一'), injectFor('session-legacy'));
}

// ---------------------------------------------------------------------------
// 9) 会话清单里带上 muted 标记（UI 用它渲染状态）
// ---------------------------------------------------------------------------
{
  await post({ action: 'mute', sessions: ['session-legacy'], muted: true });
  const overview = await get();
  const row = (overview.body.sessions ?? []).find((item) => item.sessionId === 'session-legacy');
  check('清单里有该会话', row !== undefined, JSON.stringify(overview.body.sessions));
  check('清单行带 muted 标记', row?.muted === true, JSON.stringify(row));
  const plain = (overview.body.sessions ?? []).find((item) => item.sessionId === 'session-mute-c');
  check('未豁免会话 muted 为 false', plain === undefined || plain.muted === false, JSON.stringify(plain));
}

fs.rmSync(home, { recursive: true, force: true });

if (failures.length === 0) {
  console.log('OK all dialog-fence session-mute assertions passed');
} else {
  console.error(`FAIL: ${failures.length} 处不满足：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
