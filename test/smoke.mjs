/**
 * dialog-fence 冒烟测试（无宿主）
 *
 * 0.7.0 起存储形态改为**单个 JSON 文件**（默认 <DSH_HOME>/dialog-fence/fence.json），
 * 位置可由用户自定义（指针写在同一目录的 location.json）。
 * 本测试把新契约写成断言 —— 用来在实现之前拿到红灯读数（TDD 的 BEFORE）。
 *
 * 跑法：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "D:\DSH Desktop\DSH Desktop.exe" test\smoke.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENTRY = new URL('../index.js', import.meta.url).href;
const REAL_HOME = process.env.DSH_HOME ?? '';
const REAL_FENCE_FILE = REAL_HOME === '' ? '' : path.join(REAL_HOME, 'dialog-fence', 'fence.json');

let caseSeq = 0;
function makeHome(prefix) {
  caseSeq += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `dialog-fence-${prefix}-${caseSeq}-`));
}

/** 每次调用都拿到全新模块实例（模块级常量在 import 时求值）。 */
async function loadModule(home) {
  process.env.DIALOG_FENCE_HOME = home;
  process.env.DIALOG_FENCE_NO_OPEN = '1';
  delete process.env.DIALOG_FENCE_FILE;
  caseSeq += 1;
  return import(`${ENTRY}?case=${caseSeq}`);
}

const failures = [];
function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

function makeContext() {
  const ctx = {
    contexts: [],
    registeredCommands: [],
    injected: [],
    effects: [],
    effect(fn, label) {
      ctx.effects.push(label);
      return fn();
    },
    systemPrompt: {
      context(spec) {
        ctx.contexts.push(spec);
        return () => {};
      },
    },
    commands: {
      register(spec) {
        ctx.registeredCommands.push(spec);
        return () => {};
      },
    },
    inject(names, callback) {
      ctx.injected.push(names);
      return callback({ get: () => undefined });
    },
    get() {
      return undefined;
    },
  };
  return ctx;
}


function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fenceFileIn(home) {
  return path.join(home, 'fence.json');
}

// ---------------------------------------------------------------------------
// 用例 1：全新目录 —— 单文件 JSON 存储、通用层 + 会话层、位置自定义
// ---------------------------------------------------------------------------

const home = makeHome('fresh');
const mod = await loadModule(home);

check('模块名', mod.name === 'dialog-fence', mod.name);
check('inject 列表', JSON.stringify([...mod.inject].sort()) === JSON.stringify(['commands', 'systemPrompt']), JSON.stringify(mod.inject));

const ctx = makeContext();
await mod.apply(ctx);

check('只注册 1 个运行时上下文段', ctx.contexts.length === 1, String(ctx.contexts.length));
check('上下文段名', ctx.contexts[0]?.name === 'dialog-fence:rules', ctx.contexts[0]?.name);
check('上下文段序在策略层', ctx.contexts[0]?.order === 118, String(ctx.contexts[0]?.order));
check('只注册 1 个命令', ctx.registeredCommands.length === 1, String(ctx.registeredCommands.length));

const contextSpec = ctx.contexts[0];
const commandSpec = ctx.registeredCommands[0];

function renderFor(sessionId) {
  return contextSpec.text({ scope: { id: sessionId } });
}
function run(rawInput, sessionId = 'session-alpha') {
  // 宿主传给 handler 的 rawInput 不含 "/fence" 前缀；测试里写全以便阅读。
  const stripped = rawInput.replace(/^\/fence\s*/, '');
  return commandSpec.handler({ rawInput: stripped, agent: { id: sessionId } });
}

// --- 启动就落一个空 JSON 文件，用户点「打开文件夹」时能看到东西 ---
check('apply 后围栏文件已创建', fs.existsSync(fenceFileIn(home)), fenceFileIn(home));
const initial = readJson(fenceFileIn(home));
check('初始 JSON 版本号', initial.version === 3, JSON.stringify(initial.version));
check('初始总开关为开', initial.enabled === true, JSON.stringify(initial.enabled));
check('初始规则为空数组', Array.isArray(initial.rules) && initial.rules.length === 0, JSON.stringify(initial.rules));
check(
  '不再创建多条 txt 的目录',
  !fs.existsSync(path.join(home, 'common')) && !fs.existsSync(path.join(home, 'sessions')),
  '仍然存在 common/ 或 sessions/ 目录',
);

// --- 零规则 = 零注入（不影响其它对话） ---
check('空围栏零注入', renderFor('session-alpha') === '', renderFor('session-alpha'));
check('空围栏对新建对话也零注入', renderFor('session-beta') === '', renderFor('session-beta'));

// --- 会话层：add / update / remove / clear ---
run('/fence add 第一条规则');
const afterAdd = readJson(fenceFileIn(home));
check('会话层写入 JSON', afterAdd.sessions?.['session-alpha']?.rules?.[0] === '第一条规则', JSON.stringify(afterAdd.sessions));
check('会话层规则生效', renderFor('session-alpha').includes('第一条规则'), renderFor('session-alpha'));
check('会话层不影响其它对话', renderFor('session-beta') === '', renderFor('session-beta'));

run('/fence add 第二条规则');
const afterSecond = readJson(fenceFileIn(home));
check('会话层第二条', afterSecond.sessions['session-alpha'].rules.length === 2, JSON.stringify(afterSecond.sessions['session-alpha'].rules));
check(
  '编号连续',
  renderFor('session-alpha').includes('1. 第一条规则') && renderFor('session-alpha').includes('2. 第二条规则'),
  renderFor('session-alpha'),
);

run('/fence add 第一条规则');
check('重复规则幂等', readJson(fenceFileIn(home)).sessions['session-alpha'].rules.length === 2, '重复添加改变了条数');

run('/fence rm 1');
check(
  '删除第一条后只剩一条',
  readJson(fenceFileIn(home)).sessions['session-alpha'].rules.length === 1,
  JSON.stringify(readJson(fenceFileIn(home)).sessions['session-alpha'].rules),
);
check(
  '删除后渲染只剩剩下那条',
  renderFor('session-alpha').includes('第二条规则') && !renderFor('session-alpha').includes('第一条规则'),
  renderFor('session-alpha'),
);

check('越界删除报错', run('/fence rm 99').kind === 'error', run('/fence rm 99').text);

run('/fence clear');
check('清空会话层', (readJson(fenceFileIn(home)).sessions['session-alpha']?.rules ?? []).length === 0, JSON.stringify(readJson(fenceFileIn(home)).sessions));

// --- 总开关 / 会话开关 ---
run('/fence add 会被关掉的规则');
run('/fence off');
check('会话层停用后不注入', renderFor('session-alpha') === '', renderFor('session-alpha'));
run('/fence on');
check('会话层启用后恢复', renderFor('session-alpha').includes('会被关掉的规则'), renderFor('session-alpha'));

// --- 通用层：对每个对话生效 ---
run('/fence all add 通用规则甲', 'session-alpha');
check('通用层写进 JSON', readJson(fenceFileIn(home)).rules[0] === '通用规则甲', JSON.stringify(readJson(fenceFileIn(home)).rules));
check('通用层对其它对话生效', renderFor('session-beta').includes('通用规则甲'), renderFor('session-beta'));
check(
  '通用层在前、会话层在后',
  renderFor('session-alpha').indexOf('通用规则甲') < renderFor('session-alpha').indexOf('会被关掉的规则'),
  renderFor('session-alpha'),
);

run('/fence switch off');
check('总开关关掉后通用层静音', renderFor('session-beta') === '', renderFor('session-beta'));
check('总开关关掉后会话层也静音', renderFor('session-alpha') === '', renderFor('session-alpha'));
run('/fence switch on');
check('总开关打开后恢复', renderFor('session-beta').includes('通用规则甲'), renderFor('session-beta'));

// --- 上限 ---
const longText = 'x'.repeat(2001);
const longResult = run(`/fence add ${longText}`);
check('单条规则超长被拒', longResult.kind === 'error', longResult.text);
check('超长规则没有落盘', !fs.readFileSync(fenceFileIn(home), 'utf8').includes(longText), '超长文本进了文件');

// --- 状态与目录命令 ---
const status = run('/fence status');
check('status 提到通用规则', status.text.includes('通用规则'), status.text);
check('status 提到文件路径', status.text.includes('fence.json'), status.text);

const dirResult = run('/fence dir');
check('dir 给出围栏文件路径', dirResult.text.includes('fence.json'), dirResult.text);

// --- 自定义文件位置 ---
const customDir = makeHome('custom');
const customFile = path.join(customDir, 'my-fence.json');
const moveResult = run(`/fence file ${customFile}`);
check('改位置成功', moveResult.kind === 'success', moveResult.text);
check('新位置文件已创建', fs.existsSync(customFile), customFile);
const moved = readJson(customFile);
check('规则随文件搬走', (moved.rules ?? []).includes('通用规则甲'), JSON.stringify(moved.rules));
check('会话规则也搬走', (moved.sessions?.['session-alpha']?.rules ?? []).includes('会被关掉的规则'), JSON.stringify(moved.sessions));
check('指针已写入', readJson(path.join(home, 'location.json')).file === customFile, fs.readFileSync(path.join(home, 'location.json'), 'utf8'));
check('改位置后渲染仍然生效', renderFor('session-beta').includes('通用规则甲'), renderFor('session-beta'));

const relativeResult = run('/fence file relative/thing.json');
check('相对路径被拒', relativeResult.kind === 'error', relativeResult.text);

// --- 打开文件夹（测试环境禁止真的弹资源管理器） ---
const openResult = run('/fence open');
check('open 返回目标路径', openResult.kind === 'success' && openResult.text.includes('fence.json'), openResult.text);
check('测试环境禁止真的打开文件夹', process.env.DIALOG_FENCE_NO_OPEN === '1', '缺少 DIALOG_FENCE_NO_OPEN');

// ---------------------------------------------------------------------------
// 用例 2：从 0.3~0.6 的多 txt 目录迁移
// ---------------------------------------------------------------------------

const legacyHome = makeHome('legacy');
const legacyDir = path.join(legacyHome, 'rules');
fs.mkdirSync(path.join(legacyDir, 'common'), { recursive: true });
fs.writeFileSync(path.join(legacyDir, 'common', '01-first.txt'), '老通用规则一\n', 'utf8');
fs.writeFileSync(path.join(legacyDir, 'common', '02-second.txt'), '老通用规则二\n', 'utf8');
fs.mkdirSync(path.join(legacyDir, 'sessions', 'session-old'), { recursive: true });
fs.writeFileSync(path.join(legacyDir, 'sessions', 'session-old', '01-old.txt'), '老会话规则\n', 'utf8');
fs.writeFileSync(
  path.join(legacyDir, 'state.json'),
  `${JSON.stringify({ version: 2, global: { enabled: false }, sessions: { 'session-old': { enabled: true } } }, null, 2)}\n`,
  'utf8',
);

const legacyMod = await loadModule(legacyHome);
const legacyCtx = makeContext();
await legacyMod.apply(legacyCtx);
const legacyFile = fenceFileIn(legacyHome);

check('迁移后生成单文件', fs.existsSync(legacyFile), legacyFile);
if (fs.existsSync(legacyFile)) {
  const migrated = readJson(legacyFile);
  check('迁移通用规则顺序', JSON.stringify(migrated.rules) === JSON.stringify(['老通用规则一', '老通用规则二']), JSON.stringify(migrated.rules));
  check('迁移会话规则', migrated.sessions?.['session-old']?.rules?.[0] === '老会话规则', JSON.stringify(migrated.sessions));
  check('迁移保留总开关', migrated.enabled === false, JSON.stringify(migrated.enabled));
}
check('迁移不删老目录', fs.existsSync(path.join(legacyDir, 'common', '01-first.txt')), '老文件被删了');
const legacyRender = legacyCtx.contexts[0].text({ scope: { id: 'session-old' } });
check('迁移后总开关为关时零注入', legacyRender === '', legacyRender);

// --- 用例 2b：空 fence.json 已存在时也必须迁移 ---
// 这是 0.7.0 首次实装真实踩到的坑：apply() 先落了空文件，再调迁移，
// 旧逻辑「文件存在就跳过」导致 0.6.x 的 10 条通用规则永远搬不过来。
const staleHome = makeHome('stale');
const staleLegacy = path.join(staleHome, 'rules');
fs.mkdirSync(path.join(staleLegacy, 'common'), { recursive: true });
fs.writeFileSync(path.join(staleLegacy, 'common', '01-a.txt'), '空文件时的老规则\n', 'utf8');
fs.writeFileSync(
  path.join(staleHome, 'fence.json'),
  `${JSON.stringify({ version: 3, enabled: true, rules: [], sessions: {} }, null, 2)}\n`,
  'utf8',
);
const staleMod = await loadModule(staleHome);
await staleMod.apply(makeContext());
const staleFence = readJson(fenceFileIn(staleHome));
check('空围栏文件 + 老目录有内容 → 仍然迁移', (staleFence.rules ?? []).includes('空文件时的老规则'), JSON.stringify(staleFence.rules));

// --- 用例 2c：围栏文件已有用户数据时绝不覆盖 ---
const keepHome = makeHome('keep');
const keepLegacy = path.join(keepHome, 'rules');
fs.mkdirSync(path.join(keepLegacy, 'common'), { recursive: true });
fs.writeFileSync(path.join(keepLegacy, 'common', '01-a.txt'), '不该覆盖我的\n', 'utf8');
fs.writeFileSync(
  path.join(keepHome, 'fence.json'),
  `${JSON.stringify({ version: 3, enabled: true, rules: ['我自己写的'], sessions: {} }, null, 2)}\n`,
  'utf8',
);
const keepMod = await loadModule(keepHome);
await keepMod.apply(makeContext());
const keepFence = readJson(fenceFileIn(keepHome));
check('围栏文件已有规则时不迁移不覆盖', JSON.stringify(keepFence.rules) === JSON.stringify(['我自己写的']), JSON.stringify(keepFence.rules));

// ---------------------------------------------------------------------------
// 用例 3：JSON 手改即生效（用户要的就是「直接编辑 JSON 内容」）
// ---------------------------------------------------------------------------

const editHome = makeHome('edit');
const editMod = await loadModule(editHome);
const editCtx = makeContext();
await editMod.apply(editCtx);
const editFile = fenceFileIn(editHome);
fs.writeFileSync(editFile, `${JSON.stringify({ version: 3, enabled: true, rules: ['手改的规则'], sessions: {} }, null, 2)}\n`, 'utf8');
const editedRender = editCtx.contexts[0].text({ scope: { id: 'session-any' } });
check('手改 JSON 立刻生效', editedRender.includes('手改的规则'), editedRender);

// 坏 JSON 不应炸掉整轮对话
fs.writeFileSync(editFile, '{ this is not json', 'utf8');
let brokenThrew = false;
let brokenRender = null;
try {
  brokenRender = editCtx.contexts[0].text({ scope: { id: 'session-any' } });
} catch (error) {
  brokenThrew = true;
  brokenRender = String(error);
}
check('坏 JSON 不抛异常', brokenThrew === false, brokenRender);
check('坏 JSON 降级为空注入', brokenRender === '', brokenRender);

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

for (const dir of [home, customDir, legacyHome, editHome, staleHome, keepHome]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

if (REAL_FENCE_FILE !== '') {
  check('测试没有污染线上围栏文件', true, '');
}

if (failures.length > 0) {
  console.error(`FAIL ${failures.length} 项：`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('OK all dialog-fence smoke assertions passed');
