/**
 * 无宿主冒烟测试：用假的 ctx 跑通 index.js 的全部路径。
 *
 * 覆盖 0.3.0 的存储形态：**每条规则一个 .txt 文件**
 *   <DATA_DIR>/sessions/<sessionId>/NN-<slug>.txt
 *   <DATA_DIR>/state.json                     ← 只存开关
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "D:\DSH Desktop\DSH Desktop.exe" "...\dialog-fence\test\smoke.mjs"
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginUrl = new URL('../index.js', import.meta.url).href;

// 测试绝不碰线上规则目录：指向一次性临时目录，跑完即删。
// 否则测试中途崩溃就会把用户真实规则改掉。
const sandboxDir = mkdtempSync(join(tmpdir(), 'dialog-fence-smoke-'));
const dataDir = join(sandboxDir, 'rules');
process.env.DIALOG_FENCE_DIR = dataDir;

// ---- 假宿主 ----------------------------------------------------------------
const registered = { contexts: [], commands: [], disposers: [], injected: [] };

function makeCtx({ withConnection = false } = {}) {
  return {
    effect(fn, label) {
      const dispose = fn();
      registered.disposers.push({ label, dispose });
      return dispose;
    },
    systemPrompt: {
      context(spec) {
        registered.contexts.push(spec);
        return () => {};
      },
    },
    commands: {
      register(spec) {
        registered.commands.push(spec);
        return () => {};
      },
    },
    // 0.3.0 用 ctx.inject 等 connection 就绪；没有该服务时回调永不触发。
    inject(names, callback) {
      registered.injected.push([...names]);
      if (!withConnection) return () => {};
      const connectionCtx = {
        effect(fn) {
          return fn();
        },
        get(name) {
          if (name !== 'connection') return undefined;
          return {
            fetch: {
              register() {
                return () => {};
              },
            },
          };
        },
      };
      return callback(connectionCtx);
    },
    get(name) {
      if (name !== 'connection' || !withConnection) return undefined;
      return { fetch: { register: () => () => {} } };
    },
  };
}

const mod = await import(pluginUrl);
assert.equal(mod.name, 'dialog-fence', 'name');
assert.deepEqual([...mod.inject].sort(), ['commands', 'systemPrompt'], 'inject list');
assert.equal(typeof mod.apply, 'function', 'apply is a function');

const ctx = makeCtx();
await mod.apply(ctx);

assert.equal(registered.contexts.length, 1, 'register exactly one runtime context');
assert.equal(registered.commands.length, 1, 'register exactly one command');
assert.deepEqual(registered.injected, [['connection']], 'waits for the connection service instead of soft-getting it');
assert.ok(existsSync(join(dataDir, 'sessions')), 'creates the sessions directory on startup');

const contextSpec = registered.contexts[0];
assert.equal(contextSpec.name, 'dialog-fence:rules');
assert.ok(Number.isFinite(contextSpec.order), 'order must be finite');
assert.equal(typeof contextSpec.text, 'function', 'text stays a function (no system-prompt rewrite)');

const commandSpec = registered.commands[0];
assert.equal(commandSpec.name, 'fence');
assert.equal(typeof commandSpec.handler, 'function');

// ---- 隔离性：任何未登记的会话都必须渲染成空串 -------------------------------
const renderFor = (id) => contextSpec.text({ scope: { id } });
assert.equal(renderFor('session-not-registered'), '', 'unknown session injects nothing');
assert.equal(renderFor(''), '', 'empty session id injects nothing');
assert.equal(contextSpec.text({}), '', 'missing scope injects nothing');
assert.equal(contextSpec.text({ scope: {} }), '', 'scope without id injects nothing');

// ---- 命令路径 ---------------------------------------------------------------
const SESSION = `session-smoke-${Date.now()}`;
const run = (rawInput) => commandSpec.handler({ rawInput, agent: { id: SESSION } });

let result = run('');
assert.equal(result.kind, 'success', 'bare /fence reports status');
assert.match(result.text, /未启用/);

result = run('dir');
assert.equal(result.kind, 'success', '/fence dir works');
assert.match(result.text, /sessions/);

result = run('add 不要修改 D:\\workspace 以外的文件');
assert.equal(result.kind, 'success', `/fence add works: ${result.text}`);

// 每条规则 = 一个 txt 文件
const sessionDir = join(dataDir, 'sessions', SESSION);
assert.ok(existsSync(sessionDir), 'session directory created');
let files = readdirSync(sessionDir).filter((entry) => entry.endsWith('.txt'));
assert.equal(files.length, 1, 'one rule = one txt file');
assert.match(files[0], /^01-/, 'file name carries an order prefix');
assert.match(readFileSync(join(sessionDir, files[0]), 'utf8'), /不要修改/, 'file body is the rule text');

// add 之后即使没有显式 on，也应该自动启用
const injected = renderFor(SESSION);
assert.ok(injected.length > 0, 'enabled session injects text');
assert.match(injected, /Dialog fence/);
assert.match(injected, /不要修改/);

// 其它会话仍然零注入
assert.equal(renderFor('session-somebody-else'), '', 'other sessions stay empty');

result = run('add 回答必须标注不确定性');
assert.equal(result.kind, 'success');
assert.match(renderFor(SESSION), /不确定性/);
files = readdirSync(sessionDir).filter((entry) => entry.endsWith('.txt')).sort();
assert.equal(files.length, 2, 'second rule gets its own file');
assert.match(files[1], /^02-/, 'prefix increments');

// 去重
result = run('add 回答必须标注不确定性');
assert.equal(result.kind, 'success');
const occurrences = renderFor(SESSION).split('不确定性').length - 1;
assert.equal(occurrences, 1, 'duplicate rule is not added twice');
assert.equal(readdirSync(sessionDir).filter((entry) => entry.endsWith('.txt')).length, 2, 'no third file for a duplicate');

// 删除
result = run('rm 1');
assert.equal(result.kind, 'success');
assert.doesNotMatch(renderFor(SESSION), /不要修改/, 'rm removed the first rule');
assert.equal(readdirSync(sessionDir).filter((entry) => entry.endsWith('.txt')).length, 1, 'rm deleted the file');

// 越界删除必须报错
assert.equal(run('rm 99').kind, 'error', 'out-of-range rm is rejected');
assert.equal(run('rm abc').kind, 'error', 'non-numeric rm is rejected');

// ---- 直接操作文件：这是「方便随时配置和维护」的核心 ---------------------------
// 1) 直接丢一个 txt 进去（该会话在 state.json 里没有条目）→ 自动生效
const DROP = `session-drop-${Date.now()}`;
const dropDir = join(dataDir, 'sessions', DROP);
mkdirSync(dropDir, { recursive: true });
writeFileSync(join(dropDir, '01-dropped.txt'), '直接丢进来的规则\n', 'utf8');
assert.match(renderFor(DROP), /直接丢进来的规则/, 'dropping a txt file is enough to enable the session');

// 2) 直接改文件内容 → 注入文本立刻跟着变
writeFileSync(join(dropDir, '01-dropped.txt'), '改过的规则正文\n', 'utf8');
assert.match(renderFor(DROP), /改过的规则正文/, 'editing the txt changes the injected text');
assert.doesNotMatch(renderFor(DROP), /直接丢进来的规则/, 'old text is gone');

// 3) 直接删文件 → 规则消失
unlinkSync(join(dropDir, '01-dropped.txt'));
assert.equal(renderFor(DROP), '', 'deleting the txt removes the rule');

// 4) 空文件不算规则
writeFileSync(join(dropDir, '01-empty.txt'), '   \n\n', 'utf8');
assert.equal(renderFor(DROP), '', 'blank file is ignored');
unlinkSync(join(dropDir, '01-empty.txt'));

// off -> 零注入（文件仍在）
result = run('off');
assert.equal(result.kind, 'success');
assert.equal(renderFor(SESSION), '', 'off injects nothing');
assert.equal(readdirSync(sessionDir).filter((entry) => entry.endsWith('.txt')).length, 1, 'off keeps the rule files');

// clear 清空规则
run('on');
run('add 测试规则');
assert.ok(renderFor(SESSION).length > 0);
result = run('clear');
assert.equal(result.kind, 'success');
assert.equal(renderFor(SESSION), '', 'clear leaves no rules');
assert.equal(readdirSync(sessionDir).filter((entry) => entry.endsWith('.txt')).length, 0, 'clear deleted the files');

// 未知子命令
assert.equal(run('bogus').kind, 'error', 'unknown verb is rejected');

// reset 删除记录
run('add 待清理');
run('reset');
assert.equal(renderFor(SESSION), '', 'reset removes the session record files');

// 长文本截断：40 条上限 + 2400 字符上限
for (let i = 0; i < 45; i += 1) {
  const r = run(`add 规则编号 ${i} ${'x'.repeat(60)}`);
  if (r.kind === 'error') break;
}
const capped = renderFor(SESSION);
assert.ok(capped.length <= 2600, `rendered text stays bounded (got ${capped.length})`);
assert.match(capped, /truncated|规则编号 0/, 'still renders rules under the cap');
assert.ok(readdirSync(sessionDir).filter((entry) => entry.endsWith('.txt')).length <= 40, 'rule count is capped');

run('reset');

// 单条规则长度上限
assert.equal(run(`add ${'y'.repeat(2100)}`).kind, 'error', 'over-long single rule is rejected');
run('reset');

// ---- 编码兼容 ---------------------------------------------------------------
// 真实事故：PowerShell 覆盖文件后整个围栏无声消失，必须回归。
run('on');
run('add BOM 兼容规则');
assert.match(renderFor(SESSION), /BOM 兼容规则/, 'baseline renders');

// 规则文件本身写成 UTF-16LE（PowerShell 5.1 的 Set-Content 默认行为）
const ruleFiles = readdirSync(sessionDir).filter((entry) => entry.endsWith('.txt'));
writeFileSync(join(sessionDir, ruleFiles[0]), Buffer.from('UTF16 规则正文\r\n', 'utf16le'));
assert.match(renderFor(SESSION), /UTF16 规则正文/, 'UTF-16LE rule file is tolerated');

writeFileSync(join(sessionDir, ruleFiles[0]), `\uFEFFUTF8BOM 规则正文\n`, 'utf8');
assert.match(renderFor(SESSION), /UTF8BOM 规则正文/, 'UTF-8 with BOM rule file is tolerated');

// state.json 写成 UTF-16LE → 开关仍然被正确读取（不能静默回到默认值）
run('off');
const statePath = join(dataDir, 'state.json');
const parsedState = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
assert.equal(parsedState.sessions[SESSION].enabled, false, 'off persisted to state.json');
writeFileSync(statePath, Buffer.from(JSON.stringify(parsedState, null, 2), 'utf16le'));
assert.equal(renderFor(SESSION), '', 'UTF-16LE state.json is parsed, session stays off');
run('on');
assert.match(renderFor(SESSION), /UTF8BOM 规则正文/, 'on comes back after UTF-16LE state.json');

run('reset');

// ---- 缺 agent 的命令调用不能崩 ----------------------------------------------
const noAgent = commandSpec.handler({ rawInput: 'status' });
assert.equal(noAgent.kind, 'error', 'missing agent id is reported, not thrown');

// ---- 收尾：临时目录必须被清掉，线上规则目录一字未动 --------------------------
rmSync(sandboxDir, { recursive: true, force: true });
assert.equal(existsSync(sandboxDir), false, 'sandbox dir removed');

const liveDir = join(import.meta.dirname, '..', 'rules');
const liveSessions = join(liveDir, 'sessions');
if (existsSync(liveSessions)) {
  for (const entry of readdirSync(liveSessions)) {
    const dir = join(liveSessions, entry);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.txt')) continue;
      assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /BOM 兼容规则|UTF16 规则正文|UTF8BOM 规则正文/, 'live rules untouched by the test');
    }
  }
}

console.log('OK all dialog-fence smoke assertions passed');
console.log(`plugin: ${fileURLToPath(pluginUrl)}`);
console.log(`sandbox: ${sandboxDir} (removed)`);
