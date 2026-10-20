#!/usr/bin/env node
/**
 * dialog-fence 安装器 —— 同时支持 `dsh`（CLI）与 `dsh desktop`。
 *
 * 为什么一套脚本够用：
 *   两者启动流程是同一个 —— `dsh --profile <name>` 与 DSH Desktop 都读
 *   <DSH_HOME>/profiles/<name>/cordis.patch.yml 作为「用户补丁层」，
 *   再在其上装配 loader。所以只要往那个 patch 文件里插入一行 file:/// 插件，
 *   两种形态就同时生效，差别只在 profile 名字。
 *
 * 用法：
 *   node scripts/install.mjs install   [--profile web] [--home <DSH_HOME>] [--dry-run]
 *   node scripts/install.mjs uninstall [--profile web] [--home <DSH_HOME>] [--dry-run]
 *   node scripts/install.mjs status    [--profile web] [--home <DSH_HOME>]
 *   node scripts/install.mjs list
 *
 * 备注：改完必须**重启 DSH**（Desktop 与 CLI 都一样）。本插件的宿主半边
 * 不会被 dsh-hmr 热重载，这一点在 docs/运维手册与变更记录.md 里有实测记录。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ENTRY = join(PLUGIN_DIR, 'index.js');
const ROW_ID = 'dialog-fence';
const BEGIN = '# >>> dsh-dialog-fence (managed by scripts/install.mjs — do not edit by hand) >>>';
const END = '# <<< dsh-dialog-fence <<<';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { command: 'status', profile: undefined, home: undefined, dryRun: false };
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest.shift();
    if (token === '--profile' || token === '-p') args.profile = rest.shift();
    else if (token === '--home') args.home = rest.shift();
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--help' || token === '-h') args.command = 'help';
    else if (!token.startsWith('-')) args.command = token;
    else throw new Error(`未知参数 ${token}（用 --help 看用法）`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 定位 DSH_HOME 与 profile
// ---------------------------------------------------------------------------

function candidateHomes() {
  const homes = [];
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) homes.push(process.env.DSH_HOME);
  if (process.platform === 'win32' && typeof process.env.APPDATA === 'string') {
    homes.push(join(process.env.APPDATA, 'dsh-desktop', 'harness'));
    homes.push(join(process.env.APPDATA, 'dsh', 'harness'));
  } else {
    homes.push(join(homedir(), '.local', 'share', 'dsh', 'harness'));
    homes.push(join(homedir(), '.dsh', 'harness'));
  }
  homes.push(join(homedir(), '.dsh', 'harness'));
  return homes;
}

function resolveHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) {
    const abs = resolve(explicit);
    if (!existsSync(abs)) throw new Error(`指定的 DSH_HOME 不存在：${abs}`);
    return abs;
  }
  for (const home of candidateHomes()) {
    if (existsSync(join(home, 'profiles'))) return home;
  }
  throw new Error(
    [
      '找不到 DSH_HOME（没有 profiles 目录的候选路径）。',
      '请用 --home 显式指定，例如：',
      '  node scripts/install.mjs install --home "C:\\Users\\<你>\\AppData\\Roaming\\dsh-desktop\\harness"',
      '已尝试：',
      ...candidateHomes().map((h) => `  - ${h}`),
    ].join('\n'),
  );
}

function listProfiles(home) {
  const dir = join(home, 'profiles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(dir, name, 'package.json')) || existsSync(join(dir, name, 'cordis.patch.yml')))
    .sort();
}

/** DSH Desktop 独占的 profile 名，CLI 会拒绝；但补丁文件本身照样能写。 */
function defaultProfile(profiles) {
  if (profiles.includes('web')) return 'web';
  if (profiles.length > 0) return profiles[0];
  return 'web';
}

function patchFileOf(home, profile) {
  return join(home, 'profiles', profile, 'cordis.patch.yml');
}

// ---------------------------------------------------------------------------
// patch 文件读写
// ---------------------------------------------------------------------------

function readPatch(file) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

function blockFor() {
  const url = pathToFileURL(PLUGIN_ENTRY).href;
  return [
    BEGIN,
    '- insert:',
    `    - id: ${ROW_ID}`,
    `      name: "${url}"`,
    END,
  ].join('\n');
}

function isInstalled(text) {
  if (text === null) return false;
  return text.includes(BEGIN) || new RegExp(`^\\s*- id:\\s*${ROW_ID}\\s*$`, 'm').test(text);
}

function install(text, file) {
  const base = text === null ? '' : text;
  if (isInstalled(base)) return { text: base, changed: false, reason: `已经装过了（${file}）` };
  const body = base.length === 0 ? '[]\n' : base;
  // patch 层是一个顶层 YAML 数组：直接在末尾追加一个 insert 块。
  const separator = body.endsWith('\n') ? '' : '\n';
  const next = `${body}${separator}\n${blockFor()}\n`;
  return { text: next, changed: true, reason: 'ok' };
}

function uninstall(text, file) {
  if (text === null) return { text: null, changed: false, reason: `patch 文件不存在（${file}）` };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === BEGIN);
  if (start !== -1) {
    let end = lines.findIndex((line, index) => index > start && line.trim() === END);
    if (end === -1) end = start;
    lines.splice(start, end - start + 1);
    return { text: lines.join('\n'), changed: true, reason: 'ok（按标记块删除）' };
  }
  // 手工插入过（没有标记）：按 id 精确摘掉，避免误伤别的插件。
  const index = lines.findIndex((line) => new RegExp(`^\\s*- id:\\s*${ROW_ID}\\s*$`).test(line));
  if (index === -1) return { text, changed: false, reason: '没找到 dialog-fence 的插入行' };
  const indent = (lines[index].match(/^\s*/) ?? [''])[0];
  let take = 1;
  // 同一 insert 块里紧随其后的 name 行也一起删。
  while (index + take < lines.length && new RegExp(`^${indent}name:`).test(lines[index + take])) take += 1;
  lines.splice(index, take);
  return { text: lines.join('\n'), changed: true, reason: 'ok（按 id 删除）' };
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

function cmdInstall(args) {
  const home = resolveHome(args.home);
  const profiles = listProfiles(home);
  const profile = args.profile ?? defaultProfile(profiles);
  const file = patchFileOf(home, profile);
  if (!existsSync(join(home, 'profiles', profile))) {
    throw new Error(`profile "${profile}" 不存在。可用：${profiles.join(', ') || '（无）'}`);
  }
  const text = readPatch(file);
  const result = install(text, file);
  console.log(`DSH_HOME : ${home}`);
  console.log(`profile  : ${profile}`);
  console.log(`patch    : ${file}${text === null ? '（不存在，将新建）' : ''}`);
  console.log(`plugin   : ${PLUGIN_ENTRY}`);
  if (!result.changed) {
    console.log(`\n${result.reason}`);
    return;
  }
  if (args.dryRun) {
    console.log('\n--- dry-run，将写入以下内容 ---');
    console.log(result.text);
    return;
  }
  if (text !== null) {
    const backup = `${file}.${Date.now()}.bak`;
    copyFileSync(file, backup);
    console.log(`已备份  : ${backup}`);
  }
  writeFileSync(file, result.text, 'utf8');
  console.log('\n安装完成。**请完全退出并重启 DSH**（Desktop 与 CLI 都一样）。');
  console.log('重启后：');
  console.log('  · 会话输入框右侧会出现「围栏」按钮（仅 web / desktop 形态）');
  console.log('  · 或直接在任意会话里输入 /fence status');
}

function cmdUninstall(args) {
  const home = resolveHome(args.home);
  const profiles = args.profile !== undefined ? [args.profile] : listProfiles(home);
  let touched = 0;
  for (const profile of profiles) {
    const file = patchFileOf(home, profile);
    const text = readPatch(file);
    if (text === null) continue;
    const result = uninstall(text, file);
    if (!result.changed) continue;
    touched += 1;
    console.log(`profile ${profile}: ${result.reason}`);
    if (args.dryRun) {
      console.log('--- dry-run，不会写入 ---');
      continue;
    }
    const backup = `${file}.${Date.now()}.bak`;
    copyFileSync(file, backup);
    writeFileSync(file, result.text, 'utf8');
    console.log(`  已备份 ${backup}`);
  }
  if (touched === 0) console.log('没有需要卸载的 profile。');
  else console.log('\n卸载完成，请重启 DSH。规则目录 rules/ 未删除（每条规则一个 txt）。');
}

function cmdStatus(args) {
  const home = resolveHome(args.home);
  const profiles = listProfiles(home);
  console.log(`DSH_HOME : ${home}`);
  console.log(`plugin   : ${PLUGIN_ENTRY}${existsSync(PLUGIN_ENTRY) ? '' : '（缺失！）'}`);
  console.log(`profiles : ${profiles.join(', ') || '（无）'}`);
  const rulesDir = join(PLUGIN_DIR, 'rules');
  const sessionsDir = join(rulesDir, 'sessions');
  let sessionCount = 0;
  let ruleCount = 0;
  try {
    for (const session of readdirSync(sessionsDir)) {
      const dir = join(sessionsDir, session);
      let files = [];
      try {
        files = readdirSync(dir).filter((entry) => entry.toLowerCase().endsWith('.txt'));
      } catch {
        files = [];
      }
      if (files.length === 0) continue;
      sessionCount += 1;
      ruleCount += files.length;
    }
  } catch {
    sessionCount = 0;
    ruleCount = 0;
  }
  console.log(`rules    : ${sessionsDir}（${sessionCount} 个会话，共 ${ruleCount} 条规则）`);
  console.log('');
  for (const profile of profiles) {
    const file = patchFileOf(home, profile);
    const text = readPatch(file);
    const installed = isInstalled(text);
    console.log(`${installed ? '[已装]' : '[未装]'} ${profile}  ${file}`);
  }
}

function cmdList(args) {
  const home = resolveHome(args.home);
  console.log(`DSH_HOME : ${home}`);
  for (const profile of listProfiles(home)) console.log(`  - ${profile}`);
}

const HELP = `dialog-fence 安装器

  node scripts/install.mjs install   [--profile web] [--home <DSH_HOME>] [--dry-run]
  node scripts/install.mjs uninstall [--profile web] [--home <DSH_HOME>] [--dry-run]
  node scripts/install.mjs status    [--profile web] [--home <DSH_HOME>]
  node scripts/install.mjs list      [--home <DSH_HOME>]

说明：
  · 「dsh」与「dsh desktop」共用同一套 profile 补丁层，因此同一个命令
    对两者都有效；差别只是 --profile 的名字。
  · DSH Desktop 用的 profile 在本机叫 web；若你的环境不同，用 list 查看。
  · 安装/卸载后必须完全退出并重启 DSH（宿主半边不支持热重载）。
`;

// ---------------------------------------------------------------------------

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.command === 'help') {
      console.log(HELP);
      return 0;
    }
    if (!existsSync(PLUGIN_ENTRY)) throw new Error(`插件入口不存在：${PLUGIN_ENTRY}`);
    if (args.command === 'install') cmdInstall(args);
    else if (args.command === 'uninstall') cmdUninstall(args);
    else if (args.command === 'status') cmdStatus(args);
    else if (args.command === 'list') cmdList(args);
    else throw new Error(`未知命令 ${args.command}（用 --help 看用法）`);
    return 0;
  } catch (error) {
    console.error(`install: ${error?.message ?? error}`);
    return 1;
  }
}

process.exitCode = main();
