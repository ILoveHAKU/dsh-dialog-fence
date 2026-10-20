/**
 * HTTP 路由测试（无宿主）：只验证 index.js 注册的那条 connection 路由。
 *
 * 0.7.0 契约：**单文件 JSON** 存储（默认 <DIALOG_FENCE_HOME>/fence.json），
 * 规则按**序号**增删改（不再按文件名），位置可自定义（location.json 指针）。
 *
 * 跑法：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "D:\DSH Desktop\DSH Desktop.exe" test\route.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENTRY = new URL('../index.js', import.meta.url).href;

let caseSeq = 0;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-fence-route-'));
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
const commands = [];

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
    register(spec) {
      commands.push(spec);
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

check('只注册 1 条路由', routes.length === 1, String(routes.length));
const route = routes[0];
check('路由路径', route.path === '/api/dialog-fence', route.path);
check('路由方法', JSON.stringify([...route.methods].sort()) === JSON.stringify(['GET', 'HEAD', 'POST']), JSON.stringify(route.methods));
check('请求体按 buffered 处理', route.requestBody === 'buffered', String(route.requestBody));

const url = `http://127.0.0.1:43129${route.path}`;

async function get(query = '') {
  const response = await route.fetch(new Request(`${url}${query}`, { method: 'GET' }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function post(payload) {
  const response = await route.fetch(new Request(url, { method: 'POST', body: JSON.stringify(payload) }));
  return { status: response.status, body: await response.json() };
}

const fenceFile = path.join(home, 'fence.json');

// ---------------------------------------------------------------------------
// 1) 概览
// ---------------------------------------------------------------------------
{
  const { status, body, headers } = await get();
  check('概览 200', status === 200, String(status));
  check('概览禁缓存', headers.get('cache-control') === 'no-store', String(headers.get('cache-control')));
  check('概览 ok', body.ok === true, JSON.stringify(body));
  check('概览总开关默认开', body.globalEnabled === true, JSON.stringify(body.globalEnabled));
  check('概览通用规则为空', Array.isArray(body.common.rules) && body.common.rules.length === 0, JSON.stringify(body.common.rules));
  check('概览给出围栏文件路径', body.file === fenceFile, `${body.file} vs ${fenceFile}`);
  check('概览给出所在目录', body.dir === home, `${body.dir} vs ${home}`);
  check('概览带上限', body.limits.maxRules > 0 && body.limits.maxRuleChars === 2000, JSON.stringify(body.limits));
}

// ---------------------------------------------------------------------------
// 2) 未配置会话
// ---------------------------------------------------------------------------
{
  const { body } = await get('?sessionId=session-nobody');
  check('未配置会话未启用', body.enabled === false, JSON.stringify(body.enabled));
  check('未配置会话规则为空', body.rules.length === 0, JSON.stringify(body.rules));
  check('未配置会话零注入', body.rendered === '' && body.tokens === 0, JSON.stringify(body.rendered));
}

// ---------------------------------------------------------------------------
// 3) 会话层增删改（按序号）
// ---------------------------------------------------------------------------
{
  const added = await post({ sessionId: 'session-one', action: 'add', text: '会话规则一' });
  check('新增会话规则 200', added.status === 200, JSON.stringify(added.body));
  check('新增后自动启用', added.body.enabled === true, JSON.stringify(added.body.enabled));
  check('新增后 1 条', added.body.rules.length === 1, JSON.stringify(added.body.rules));
  check('新增后序号从 0 开始', added.body.rules[0].index === 0, JSON.stringify(added.body.rules[0]));
  check('新增后注入含规则', added.body.rendered.includes('会话规则一'), added.body.rendered);

  const duplicated = await post({ sessionId: 'session-one', action: 'add', text: '会话规则一' });
  check('重复新增幂等', duplicated.body.rules.length === 1, JSON.stringify(duplicated.body.rules));

  const other = await get('?sessionId=session-two');
  check('会话隔离', other.body.rendered === '', other.body.rendered);

  const second = await post({ sessionId: 'session-one', action: 'add', text: '会话规则二' });
  check('新增第二条', second.body.rules.length === 2, JSON.stringify(second.body.rules));

  const updated = await post({ sessionId: 'session-one', action: 'update', index: 0, text: '改过的规则' });
  check('按序号改成功', updated.body.rules[0].text === '改过的规则', JSON.stringify(updated.body.rules));

  const badUpdate = await post({ sessionId: 'session-one', action: 'update', index: 99, text: 'x' });
  check('越界改 400', badUpdate.status === 400, String(badUpdate.status));
  check('越界改有错误信息', typeof badUpdate.body.error === 'string' && badUpdate.body.error.length > 0, JSON.stringify(badUpdate.body));

  const removed = await post({ sessionId: 'session-one', action: 'remove', index: 0 });
  check('按序号删成功', removed.body.rules.length === 1 && removed.body.rules[0].text === '会话规则二', JSON.stringify(removed.body.rules));

  const badRemove = await post({ sessionId: 'session-one', action: 'remove', index: 5 });
  check('越界删 400', badRemove.status === 400, String(badRemove.status));

  const toggled = await post({ sessionId: 'session-one', action: 'toggle', enabled: false });
  check('会话停用后零注入', toggled.body.rendered === '', toggled.body.rendered);
  await post({ sessionId: 'session-one', action: 'toggle', enabled: true });

  const cleared = await post({ sessionId: 'session-one', action: 'clear' });
  check('清空会话层', cleared.body.rules.length === 0, JSON.stringify(cleared.body.rules));

  await post({ sessionId: 'session-one', action: 'add', text: '重置前的规则' });
  const reset = await post({ sessionId: 'session-one', action: 'reset' });
  check('reset 清规则且删登记', reset.body.rules.length === 0 && reset.body.enabled === false, JSON.stringify(reset.body));
}

// ---------------------------------------------------------------------------
// 4) 通用层：对每个对话生效
// ---------------------------------------------------------------------------
{
  const added = await post({ scope: 'common', action: 'add', text: '通用规则甲' });
  check('通用层新增 200', added.status === 200, JSON.stringify(added.body));
  check('通用层快照 scope', added.body.scope === 'common', String(added.body.scope));
  check('通用层 1 条', added.body.rules.length === 1, JSON.stringify(added.body.rules));
  check('通用层注入含规则', added.body.rendered.includes('通用规则甲'), added.body.rendered);

  const stranger = await get('?sessionId=session-never-configured');
  check('通用层打到从未配置的会话', stranger.body.rendered.includes('通用规则甲'), stranger.body.rendered);

  const common = await get('?scope=common');
  check('scope=common 直接取快照', common.body.scope === 'common' && common.body.rules.length === 1, JSON.stringify(common.body));

  await post({ sessionId: 'session-mix', action: 'add', text: '会话规则乙' });
  const mixed = await get('?sessionId=session-mix');
  check('通用在前会话在后', mixed.body.rendered.indexOf('通用规则甲') < mixed.body.rendered.indexOf('会话规则乙'), mixed.body.rendered);
  check('混合快照带 common 字段', mixed.body.common.rules.length === 1, JSON.stringify(mixed.body.common));

  const updated = await post({ scope: 'common', action: 'update', index: 0, text: '改过的通用规则' });
  check('通用层按序号改', updated.body.rules[0].text === '改过的通用规则', JSON.stringify(updated.body.rules));

  const removed = await post({ scope: 'common', action: 'remove', index: 0 });
  check('通用层按序号删', removed.body.rules.length === 0, JSON.stringify(removed.body.rules));

  await post({ scope: 'common', action: 'add', text: '会被总开关压掉的通用规则' });
  const off = await post({ sessionId: 'session-mix', action: 'toggleGlobal', enabled: false });
  check('总开关不需要 sessionId', off.status === 200, JSON.stringify(off.body));
  check('总开关关掉后总览为关', off.body.globalEnabled === false, JSON.stringify(off.body.globalEnabled));

  const whileOff = await get('?sessionId=session-mix');
  check('总开关关掉后通用层静音', whileOff.body.rendered === '', whileOff.body.rendered);
  const commonOff = await get('?scope=common');
  check('总开关关掉后通用层快照也不注入', commonOff.body.rendered === '' && commonOff.body.enabled === false, JSON.stringify(commonOff.body));

  await post({ action: 'toggleGlobal', enabled: true });
  const backOn = await get('?sessionId=session-mix');
  check('总开关恢复后继续注入', backOn.body.rendered.includes('会被总开关压掉的通用规则'), backOn.body.rendered);

  const cleared = await post({ scope: 'common', action: 'clear' });
  check('通用层清空', cleared.body.rules.length === 0, JSON.stringify(cleared.body.rules));
}

// ---------------------------------------------------------------------------
// 5) 单文件落盘：内容可读、JSON 结构正确
// ---------------------------------------------------------------------------
{
  check('围栏文件存在', fs.existsSync(fenceFile), fenceFile);
  const parsed = JSON.parse(fs.readFileSync(fenceFile, 'utf8'));
  check('文件 version', parsed.version === 3, JSON.stringify(parsed.version));
  check('文件 enabled 是布尔值', typeof parsed.enabled === 'boolean', JSON.stringify(parsed.enabled));
  check('文件 rules 是数组', Array.isArray(parsed.rules), JSON.stringify(parsed.rules));
  check('文件 sessions 是对象', parsed.sessions !== null && typeof parsed.sessions === 'object', JSON.stringify(parsed.sessions));
  check('会话规则落在 sessions 里', Array.isArray(parsed.sessions['session-mix']?.rules), JSON.stringify(parsed.sessions));
}

// ---------------------------------------------------------------------------
// 6) 手改 JSON 立即生效（用户要的就是这个）
// ---------------------------------------------------------------------------
{
  fs.writeFileSync(fenceFile, `${JSON.stringify({ version: 3, enabled: true, rules: ['手写的通用规则'], sessions: {} }, null, 2)}\n`, 'utf8');
  const handWritten = await get('?sessionId=session-any');
  check('手改 JSON 立即生效', handWritten.body.rendered.includes('手写的通用规则'), handWritten.body.rendered);
}

// ---------------------------------------------------------------------------
// 7) 更改文件位置 / 打开文件夹
// ---------------------------------------------------------------------------
{
  const target = path.join(home, 'nested', 'custom-fence.json');
  const moved = await post({ action: 'setFile', file: target });
  check('setFile 200', moved.status === 200, JSON.stringify(moved.body));
  check('setFile 后新文件存在', fs.existsSync(target), target);
  check('setFile 后概览指向新文件', moved.body.file === target, `${moved.body.file} vs ${target}`);
  check('搬家带着规则一起走', JSON.parse(fs.readFileSync(target, 'utf8')).rules.includes('手写的通用规则'), fs.readFileSync(target, 'utf8'));
  check('指针文件写在基目录', fs.existsSync(path.join(home, 'location.json')), 'location.json 缺失');

  const relative = await post({ action: 'setFile', file: 'relative/x.json' });
  check('相对路径被拒 400', relative.status === 400, JSON.stringify(relative.body));

  const opened = await post({ action: 'openFolder' });
  check('openFolder 200', opened.status === 200, JSON.stringify(opened.body));
  check('测试环境不真的弹窗', opened.body.opened === false, JSON.stringify(opened.body.opened));
  check('openFolder 返回目录', typeof opened.body.dir === 'string' && opened.body.dir.length > 0, JSON.stringify(opened.body.dir));
}

// ---------------------------------------------------------------------------
// 8) 错误路径
// ---------------------------------------------------------------------------
{
  const unknown = await post({ sessionId: 'session-x', action: 'nonsense' });
  check('未知动作 400', unknown.status === 400, String(unknown.status));

  const noSession = await post({ action: 'add', text: 'x' });
  check('缺 sessionId 400', noSession.status === 400, String(noSession.status));

  const empty = await post({ sessionId: 'session-x', action: 'add', text: '   ' });
  check('空规则 400', empty.status === 400, String(empty.status));

  const tooLong = await post({ sessionId: 'session-x', action: 'add', text: 'x'.repeat(2001) });
  check('超长规则 400', tooLong.status === 400, String(tooLong.status));

  const badJsonResponse = await route.fetch(new Request(url, { method: 'POST', body: 'not json' }));
  check('坏 JSON 请求体 400', badJsonResponse.status === 400, String(badJsonResponse.status));

  const del = await route.fetch(new Request(url, { method: 'DELETE' }));
  check('DELETE 405', del.status === 405, String(del.status));

  const head = await route.fetch(new Request(url, { method: 'HEAD' }));
  check('HEAD 200', head.status === 200, String(head.status));
}

// ---------------------------------------------------------------------------
// 9) 没有 connection 服务时不该多注册任何东西
// ---------------------------------------------------------------------------
{
  const soloContexts = [];
  const soloCommands = [];
  const soloRoutes = [];
  caseSeq += 1;
  const solo = await import(`${ENTRY}?no-connection=${caseSeq}`);
  await solo.apply({
    effect(fn) {
      return fn();
    },
    systemPrompt: {
      context(spec) {
        soloContexts.push(spec);
        return () => {};
      },
    },
    commands: {
      register(spec) {
        soloCommands.push(spec);
        return () => {};
      },
    },
    inject(names, callback) {
      return callback({
        get: () => undefined,
        effect: (fn) => fn(),
      });
    },
    get() {
      return undefined;
    },
  });
  check('无 connection 时 context 仍注册', soloContexts.length === 1, String(soloContexts.length));
  check('无 connection 时 command 仍注册', soloCommands.length === 1, String(soloCommands.length));
  check('无 connection 时不注册路由', soloRoutes.length === 0, String(soloRoutes.length));
}

try {
  fs.rmSync(home, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

if (failures.length > 0) {
  console.error(`FAIL ${failures.length} 项：`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('OK all dialog-fence route assertions passed');
