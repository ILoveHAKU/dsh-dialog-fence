// 开源前泄漏扫描：确保会被公开的仓库内容里不出现本机身份信息、内部工作流编号、真实会话 id。
//
// 为什么要单独一个脚本：这些东西不会让代码跑不起来，只会在仓库变 public 的那一刻
// 变成公开信息。靠人眼看 diff 是看不住的（本仓库第一次全量扫命中 60 处，人工清单只列了 4 处）。
//
// 为什么用 String.fromCharCode 拼被扫词：扫描脚本自己不能包含它要禁止的字面量，
// 否则它会把自己也判红（自指陷阱）。
//
// 扫描范围 = 工作树里的文本文件，减去被 .gitignore 忽略的（那些不会被 push，
// 例如本机运行数据 fence.json / rules/）。因此这个脚本同时验证了 .gitignore 有效。
//
// 跑法（与其它测试一致）：
//   node test/opensource.mjs
//   # DSH 内嵌 node 是 Electron，用：
//   $env:ELECTRON_RUN_AS_NODE="1"; & "D:\DSH Desktop\DSH Desktop.exe" test\opensource.mjs
//
// 通过时打印 "OK all opensource assertions passed"，退出码 0；
// 命中任何一条则打印每条命中（文件:行号）并 exit 1。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

// .git 里是历史对象（不按文本处理）；node_modules 是外部依赖；probe 是一次性取证脚本
const SKIP_DIRS = new Set(['.git', 'node_modules', 'probe']);
// 只扫这些文本后缀，避免把图片当文本读
const TEXT_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.txt', '.svg', '.html', '.patch']);

/** 把码点数组拼成字符串——刻意避免在源码里出现被禁止的字面量。 */
function fromCodes(codes) {
  return String.fromCharCode(...codes);
}

const REAL_FIRST = fromCodes([77, 97, 115, 111, 110]); // 本机用户名前半（真实英文名）
const REAL_LAST = fromCodes([87, 97, 110, 103, 45, 73, 84]); // 本机用户名后半（姓 + -IT）
const HOSTNAME = fromCodes([77, 65, 83, 79, 78, 87, 65, 78, 71, 45, 73, 84]); // 本机 hostname（无空格大写）

const RULES = [
  {
    id: 'real-name',
    // 允许中间隔空格、%20 或什么都没有（三种形态在历史里都出现过）
    pattern: new RegExp(`${REAL_FIRST}(?:\\s|%20)?${REAL_LAST}`, 'i'),
    hint: '本机用户名（真实姓名）。开源前必须替换成公开别名。',
  },
  {
    id: 'hostname',
    pattern: new RegExp(HOSTNAME, 'i'),
    hint: '本机 hostname。',
  },
  {
    id: 'internal-msg-id',
    // 形如 mNNNNN 的内部对话编号：与本项目无关，公开后无意义且暴露工作流。
    // 用模板拼接，避免注释里出现能匹配自身的样例。
    pattern: new RegExp(`\\bm${'\\d'}{5}\\b`),
    hint: '内部对话编号。改成日期或版本号更有溯源价值。',
  },
  {
    id: 'real-session-id',
    // 真实 session id：session-<uuid 前两段>。占位符 session-<uuid> 不匹配（不含十六进制段）
    pattern: /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-/,
    hint: '真实会话 id。文档里用 session-<uuid> 占位符即可。',
  },
  {
    id: 'absolute-user-path',
    // 绝对用户目录路径。占位符（含 <你>/<name>/<user> 写法，或裸「你」）本身不算泄漏。
    // 正则里不写死盘符+目录的字面量，避免这一行匹配到它自己。
    pattern: /[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'`]+)/,
    hint: '本机绝对用户路径。文档里用占位符代替具体用户名。',
    // URL 形态下占位符是百分号编码（%3C你%3E），也要认
    allow: (match) => ['你', '<你>', '<name>', '<you>', '<user>', '%3C你%3E'].includes(match[1]),
  },
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** 用 .gitignore 过滤候选文件；git 不可用时退化为不忽略（宁可多扫）。 */
function dropIgnored(candidates) {
  try {
    const stdin = candidates.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).join('\n');
    const stdout = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT,
      input: stdin,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const ignored = new Set(stdout.split(/\r?\n/).filter(Boolean));
    return candidates.filter((f) => !ignored.has(path.relative(ROOT, f).replace(/\\/g, '/')));
  } catch (error) {
    // exit code 1 = 没有任何文件被忽略（正常情况），不是失败
    if (error?.status === 1 && error?.stdout) {
      const ignored = new Set(String(error.stdout).split(/\r?\n/).filter(Boolean));
      return candidates.filter((f) => !ignored.has(path.relative(ROOT, f).replace(/\\/g, '/')));
    }
    return candidates;
  }
}

const candidates = walk(ROOT, []);
const files = dropIgnored(candidates);
const hits = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\u0000')) continue; // 二进制伪装成文本，跳过
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const rule of RULES) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
      for (const match of lines[i].matchAll(regex)) {
        if (typeof rule.allow === 'function' && rule.allow(match)) continue;
        hits.push({
          rule: rule.id,
          hint: rule.hint,
          file: path.relative(ROOT, file).replace(/\\/g, '/'),
          line: i + 1,
          // 只回显命中片段，不回显整行（整行可能带出更多私人内容）
          excerpt: match[0].length > 40 ? `${match[0].slice(0, 40)}…` : match[0],
        });
      }
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

// 扫 commit message。
//
// 为什么必须扫：第一次开源前，文件全部扫干净了，但 `git log` 里还留着
// 「User report (mNNNNN): "用户原话…"」这种消息——文件扫描器看不见它们。
// 公开之后 `git log` 是最好读的东西，对话原文和内部编号都会跟着公开。
//
// 用 --branches --tags 而不是 --all：`--all` 会把 refs/original/* 也算进来
// （filter-branch 留下的旧历史备份），导致扫到已经不该存在的旧提交。
function scanCommitMessages() {
  let shas;
  try {
    shas = execFileSync('git', ['log', '--branches', '--tags', '--format=%H'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return { scanned: 0, hits: [] }; // 不是 git 仓库（例如解压出来的源码包）就跳过
  }
  const found = [];
  for (const sha of shas) {
    const message = execFileSync('git', ['log', '-1', '--format=%B', sha], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const rule of RULES) {
      const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
      for (const match of message.matchAll(new RegExp(rule.pattern.source, flags))) {
        if (typeof rule.allow === 'function' && rule.allow(match)) continue;
        found.push({
          rule: rule.id,
          hint: `${rule.hint}（出现在 commit message 里）`,
          file: `commit ${sha.slice(0, 8)}`,
          line: 0,
          excerpt: match[0].length > 40 ? `${match[0].slice(0, 40)}…` : match[0],
        });
      }
    }
  }
  return { scanned: shas.length, hits: found };
}

const commits = scanCommitMessages();
hits.push(...commits.hits);

// 本机运行数据必须被 .gitignore 挡住——这是 fence.json / rules/ 里的会话 id 不外泄的唯一保证
assert(!files.some((f) => path.basename(f) === 'fence.json'), '.gitignore 应忽略本地数据文件 fence.json');
assert(!files.some((f) => path.relative(ROOT, f).replace(/\\/g, '/').startsWith('rules/')), '.gitignore 应忽略本地数据目录 rules/');

if (hits.length === 0) {
  console.log(`OK all opensource assertions passed（扫描 ${files.length} 个待公开文本文件 + ${commits.scanned} 条 commit message，0 处命中）`);
} else {
  console.error(`FAIL: 扫描 ${files.length} 个待公开文本文件 + ${commits.scanned} 条 commit message，命中 ${hits.length} 处：`);
  const byRule = new Map();
  for (const hit of hits) {
    if (!byRule.has(hit.rule)) byRule.set(hit.rule, []);
    byRule.get(hit.rule).push(hit);
  }
  for (const [rule, list] of byRule) {
    console.error(`\n  [${rule}] ${list[0].hint}  共 ${list.length} 处`);
    for (const hit of list) {
      console.error(`    ${hit.file}:${hit.line}  ${hit.excerpt}`);
    }
  }
  process.exitCode = 1;
}

// 自检：确保脚本本身仍然是一次有效的扫描（防止有人把 RULES 清空后「变绿」）
assert(RULES.length >= 5, '扫描规则不得少于 5 条');
assert(files.some((f) => f.endsWith('package.json')), '扫描范围应覆盖 package.json');
assert(files.some((f) => f.endsWith('.md')), '扫描范围应覆盖 markdown 文档');
