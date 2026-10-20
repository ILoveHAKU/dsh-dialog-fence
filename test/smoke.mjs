/**
 * 无宿主冒烟测试：用假的 ctx 跑通 index.js 的全部路径。
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "D:\DSH Desktop\DSH Desktop.exe" "C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\dialog-fence\test\smoke.mjs"
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginUrl = new URL('../index.js', import.meta.url).href;

// 测试绝不碰线上 rules.json：指向一次性临时目录，跑完即删。
// 否则测试中途崩溃就会把用户真实规则改掉。
const sandboxDir = mkdtempSync(join(tmpdir(), 'dialog-fence-smoke-'));
const rulesFile = join(sandboxDir, 'rules.json');
process.env.DIALOG_FENCE_RULES = rulesFile;

// ---- 假宿主 ----------------------------------------------------------------
const registered = { contexts: [], commands: [], disposers: [] };

function makeCtx() {
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

const contextSpec = registered.contexts[0];
assert.equal(contextSpec.name, 'dialog-fence:rules');
assert.equal(typeof contextSpec.order, 'number');
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

result = run('add 不要修改 D:\workspace 以外的文件');
assert.equal(result.kind, 'success', `/fence add works: ${result.text}`);

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

// 去重
result = run('add 回答必须标注不确定性');
assert.equal(result.kind, 'success');
const occurrences = renderFor(SESSION).split('不确定性').length - 1;
assert.equal(occurrences, 1, 'duplicate rule is not added twice');

// 删除
result = run('rm 1');
assert.equal(result.kind, 'success');
assert.doesNotMatch(renderFor(SESSION), /不要修改/, 'rm removed the first rule');

// 越界删除必须报错
assert.equal(run('rm 99').kind, 'error', 'out-of-range rm is rejected');
assert.equal(run('rm abc').kind, 'error', 'non-numeric rm is rejected');

// off -> 零注入
result = run('off');
assert.equal(result.kind, 'success');
assert.equal(renderFor(SESSION), '', 'off injects nothing');

// clear 清空规则
run('on');
run('add 测试规则');
assert.ok(renderFor(SESSION).length > 0);
result = run('clear');
assert.equal(result.kind, 'success');
assert.equal(renderFor(SESSION), '', 'clear leaves no rules');

// 未知子命令
assert.equal(run('bogus').kind, 'error', 'unknown verb is rejected');

// reset 删除记录
run('add 待清理');
run('reset');
assert.equal(renderFor(SESSION), '', 'reset removes the session record');

// 长文本截断：40 条上限 + 2400 字符上限
for (let i = 0; i < 45; i += 1) {
  const r = run(`add 规则编号 ${i} ${'x'.repeat(60)}`);
  if (r.kind === 'error') break;
}
const capped = renderFor(SESSION);
assert.ok(capped.length <= 2600, `rendered text stays bounded (got ${capped.length})`);
assert.match(capped, /truncated|规则编号 0/, 'still renders rules under the cap');

run('reset');

// ---- 编码兼容：带 BOM / UTF-16LE 的 rules.json 不能被静默解析失败 ------------
// 真实事故：PowerShell 覆盖 rules.json 后整个围栏无声消失，必须回归。
run('on');
run('add BOM 兼容规则');
assert.match(renderFor(SESSION), /BOM 兼容规则/, 'baseline renders');

const parsed = JSON.parse(readFileSync(rulesFile, 'utf8').replace(/^\uFEFF/, ''));
writeFileSync(rulesFile, `\uFEFF${JSON.stringify(parsed, null, 2)}`, 'utf8');
assert.match(renderFor(SESSION), /BOM 兼容规则/, 'UTF-8 with BOM is tolerated');

writeFileSync(rulesFile, Buffer.from(JSON.stringify(parsed, null, 2), 'utf16le'));
assert.match(renderFor(SESSION), /BOM 兼容规则/, 'UTF-16LE is tolerated');

run('reset');

// ---- 缺 agent 的命令调用不能崩 ----------------------------------------------
const noAgent = commandSpec.handler({ rawInput: 'status' });
assert.equal(noAgent.kind, 'error', 'missing agent id is reported, not thrown');

// ---- 收尾：临时规则目录必须被清掉，线上 rules.json 一字未动 ------------------
rmSync(sandboxDir, { recursive: true, force: true });
const liveRules = fileURLToPath(new URL('../rules.json', import.meta.url));
assert.equal(existsSync(sandboxDir), false, 'sandbox dir removed');
if (existsSync(liveRules)) {
  assert.doesNotMatch(readFileSync(liveRules, 'utf8'), /BOM 兼容规则/, 'live rules.json untouched by the test');
}

console.log('OK all dialog-fence smoke assertions passed');
console.log(`plugin: ${fileURLToPath(pluginUrl)}`);
console.log(`sandbox: ${sandboxDir} (removed)`);
