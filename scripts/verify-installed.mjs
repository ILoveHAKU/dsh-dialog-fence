/**
 * 安装后验证（Installed-copy verification）
 *
 * 目的：不依赖仓库源码，直接加载「profile 里已安装的那份插件」
 *   （默认 <DSH_HOME>/profiles/web/node_modules/dsh-dialog-fence），
 *   验证 0.13.0 的单条规则启停（toggleRule）在安装副本上真的生效。
 *
 * 跑法（Run）：
 *   node scripts/verify-installed.mjs
 *   node scripts/verify-installed.mjs --entry "C:\path\to\node_modules\dsh-dialog-fence\index.js"
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { entry: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--entry') {
      out.entry = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function defaultEntry() {
  const home = process.env.DSH_HOME
    ?? (process.env.APPDATA === undefined
      ? undefined
      : path.join(process.env.APPDATA, 'dsh-desktop', 'harness'));
  if (home === undefined) return undefined;
  return path.join(home, 'profiles', 'web', 'node_modules', 'dsh-dialog-fence', 'index.js');
}

const args = parseArgs(process.argv.slice(2));
const ENTRY = args.entry ?? defaultEntry();
if (ENTRY === undefined || !fs.existsSync(ENTRY)) {
  console.error('找不到已安装的插件入口：' + String(ENTRY));
  console.error('用 --entry 指定 index.js 路径。');
  process.exit(1);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-fence-installed-'));
process.env.DIALOG_FENCE_HOME = home;
process.env.DIALOG_FENCE_NO_OPEN = '1';
delete process.env.DIALOG_FENCE_FILE;

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label);
    return;
  }
  failures.push(label + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

const routes = [];
const entryUrl = new URL('file://' + ENTRY.replace(/\\/gu, '/')).href;
const mod = await import(entryUrl);
const version = JSON.parse(
  fs.readFileSync(path.join(path.dirname(ENTRY), 'package.json'), 'utf8'),
).version;

await mod.apply({
  effect(fn) {
    return fn();
  },
  systemPrompt: { context: () => () => {} },
  commands: { register: () => () => {} },
  inject(names, callback) {
    const connection = { fetch: { register(spec) { routes.push(spec); return () => {}; } } };
    return callback({ get: () => connection, effect: (fn) => fn() });
  },
  get() {
    return undefined;
  },
});

console.log('已安装版本（installed version）：' + version);
console.log('入口（entry）：' + ENTRY);
console.log('隔离 HOME（isolated home）：' + home);
console.log('');

const route = routes[0];
const url = 'http://127.0.0.1:43129' + route.path;

async function post(payload) {
  const response = await route.fetch(
    new Request(url, { method: 'POST', body: JSON.stringify(payload) }),
  );
  return { status: response.status, body: await response.json() };
}

async function get(query) {
  const response = await route.fetch(new Request(url + query, { method: 'GET' }));
  return { status: response.status, body: await response.json() };
}

const sessionId = 'installed-smoke';
const RULE_A = '规则甲';
const RULE_B = '规则乙';

// 1) 新增两条规则：默认启用
await post({ action: 'add', sessionId, text: RULE_A });
const added = await post({ action: 'add', sessionId, text: RULE_B });
check('HTTP 动作 add 生效', added.status === 200 && added.body.rules?.length === 2, JSON.stringify(added.body));
check(
  '新规则默认启用（enabled === true）',
  Array.isArray(added.body.rules) && added.body.rules.every((r) => r.enabled === true),
  JSON.stringify(added.body.rules),
);
check(
  '默认两条都注入',
  String(added.body.rendered).includes(RULE_A) && String(added.body.rendered).includes(RULE_B),
  added.body.rendered,
);

// 2) 停用第一条：注入里只剩第二条，且编号从 1 连续
const off = await post({ action: 'toggleRule', sessionId, index: 0, enabled: false });
check('toggleRule 停用第一条', off.body.rules?.[0]?.enabled === false, JSON.stringify(off.body.rules));
check('停用后不再注入', !String(off.body.rendered).includes(RULE_A), off.body.rendered);
check('保留的那条仍在注入', String(off.body.rendered).includes(RULE_B), off.body.rendered);
check(
  '编号连续无空洞',
  String(off.body.rendered).includes('1. ' + RULE_B) && !String(off.body.rendered).includes('2. ' + RULE_B),
  off.body.rendered,
);

// 3) 落盘形态：rules 仍是字符串数组，ruleEnabled 为等长布尔数组
const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'fence.json'), 'utf8'));
const stored = onDisk.sessions[sessionId];
check(
  '围栏文件 rules 是字符串数组',
  Array.isArray(stored.rules) && typeof stored.rules[0] === 'string',
  JSON.stringify(stored.rules),
);
check(
  '围栏文件 ruleEnabled 等长布尔数组',
  Array.isArray(stored.ruleEnabled)
    && stored.ruleEnabled.length === stored.rules.length
    && stored.ruleEnabled.every((v) => typeof v === 'boolean'),
  JSON.stringify(stored.ruleEnabled),
);
check(
  '停用位已落盘为 false',
  stored.ruleEnabled[0] === false && stored.ruleEnabled[1] === true,
  JSON.stringify(stored.ruleEnabled),
);

// 4) 重新启用：恢复注入
const on = await post({ action: 'toggleRule', sessionId, index: 0, enabled: true });
check(
  'toggleRule 启用回来后恢复注入',
  String(on.body.rendered).includes(RULE_A) && String(on.body.rendered).includes(RULE_B),
  on.body.rendered,
);

// 5) 全部停用：不注入
await post({ action: 'toggleRule', sessionId, index: 0, enabled: false });
const allOff = await post({ action: 'toggleRule', sessionId, index: 1, enabled: false });
check('全部停用后 rendered 为空', allOff.body.rendered === '', JSON.stringify(allOff.body.rendered));

// 5.5) 0.14.0 整条对话豁免：一次提交一个（多选走同一动作，这里只验一条以免 token 失控）
await post({ action: 'toggleRule', sessionId, index: 0, enabled: true });
await post({ action: 'toggleRule', sessionId, index: 1, enabled: true });
const muted = await post({ action: 'mute', sessions: [sessionId], muted: true });
// mute 返回的是 overview（没有 rendered 字段），注入结果要再拉一次会话快照。
const mutedSnapshot = await get('?sessionId=' + encodeURIComponent(sessionId));
check(
  '整条对话豁免后 rendered 为空（通用 + 专属都不注入）',
  mutedSnapshot.status === 200 && mutedSnapshot.body.rendered === '',
  JSON.stringify(mutedSnapshot.body.rendered),
);
check(
  'overview 的 mutedSessions 带上该会话',
  Array.isArray(muted.body.mutedSessions) && muted.body.mutedSessions.includes(sessionId),
  JSON.stringify(muted.body.mutedSessions),
);
check(
  '会话快照标记 muted',
  mutedSnapshot.body.muted === true,
  JSON.stringify(mutedSnapshot.body.muted),
);
const mutedDisk = JSON.parse(fs.readFileSync(path.join(home, 'fence.json'), 'utf8'));
check(
  '豁免名单已落盘、规则一条都没删',
  Array.isArray(mutedDisk.mutedSessions)
    && mutedDisk.mutedSessions.includes(sessionId)
    && Array.isArray(mutedDisk.sessions[sessionId].rules)
    && mutedDisk.sessions[sessionId].rules.length === 2,
  JSON.stringify({ muted: mutedDisk.mutedSessions, rules: mutedDisk.sessions[sessionId].rules }),
);
const unmuted = await post({ action: 'mute', sessions: [sessionId], muted: false });
const unmutedSnapshot = await get('?sessionId=' + encodeURIComponent(sessionId));
check(
  '取消豁免后原样恢复注入',
  String(unmutedSnapshot.body.rendered).includes(RULE_A)
    && String(unmutedSnapshot.body.rendered).includes(RULE_B)
    && unmutedSnapshot.body.muted === false,
  JSON.stringify({ rendered: unmutedSnapshot.body.rendered, muted: unmutedSnapshot.body.muted }),
);

// 6) 前端产物：安装副本的 client.js 必须带「单条开关」的样式与接线
const clientPath = path.join(path.dirname(ENTRY), 'client.js');
if (!fs.existsSync(clientPath)) {
  check('安装副本带 client.js', false, clientPath);
} else {
  const clientSource = fs.readFileSync(clientPath, 'utf8');
  check('client.js 带开关样式 .dialog-fence-switch', clientSource.includes('.dialog-fence-switch{'));
  check('client.js 认得 rule.enabled（缺字段按启用）', clientSource.includes('const on = rule.enabled !== false;'));
  const toggleCalls = (clientSource.match(/toggleRule/gu) ?? []).length;
  check('通用层与专属层都接 toggleRule（>=2 处）', toggleCalls >= 2, String(toggleCalls));
  check('开关按 role="switch" 暴露给读屏', clientSource.includes("role: 'switch'"));
  check(
    'client.js 带「不使用围栏的对话」多选区（0.14.0）',
    clientSource.includes("'dialog-fence-mute-list'")
      && clientSource.includes("'dialog-fence-mute-name'")
      && clientSource.includes('.dialog-fence-mute-name{'),
  );
  check(
    '多选区是独立行、不寄生在 picker-row 上',
    !/className: 'dialog-fence-picker-row',[\s\S]{0,200}dialog-fence-mute-/u.test(clientSource),
  );
}

// 7) 清理隔离目录
fs.rmSync(home, { recursive: true, force: true });

console.log('');
if (failures.length === 0) {
  console.log('OK installed dialog-fence ' + version + ' per-rule toggle + session mute verified');
  process.exit(0);
}
console.error('FAILED ' + failures.length + ' assertion(s):');
for (const line of failures) console.error(' - ' + line);
process.exit(1);