// 对外介绍的「中英双语、中文优先」检查。
//
// 为什么要机器检查而不是靠眼看：双语最容易退化成「某天只改了中文那半句」，
// 而这件事在 diff 里完全看不出来——两行都在，只是有一行过时了。
// 这里只钉住**结构**：中文必须在前、英文必须存在、每个标题都带英文后缀。
// 文案好不好看不归测试管。
//
// 覆盖的「对外介绍」范围：
//   package.json 的 description（插件页卡片、npm 页面、市场条目都用它）
//   README.md（仓库首页）
//   .github/SECURITY.md（安全页）
//   .github/ISSUE_TEMPLATE/*.yml 与 .github/pull_request_template.md（提 issue / PR 的人先看到的东西）
//
// 仓库 About（右侧 description）不在仓库里，靠 gh api 改，测试管不到——见 README「上架清单」。
//
// 跑法（与其它测试一致）：
//   node test/docs.mjs
//   # DSH 内嵌 node 是 Electron，用：
//   $env:ELECTRON_RUN_AS_NODE="1"; & "D:\DSH Desktop\DSH Desktop.exe" test\docs.mjs
//
// 通过时打印 "OK all docs assertions passed"，退出码 0；否则列出每条问题并 exit 1。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 是否含中日韩统一表意文字（用来判断「这段有中文」）。 */
const CJK = /[\u4e00-\u9fff]/;
/** 是否含拉丁字母（用来判断「这段有英文」）。 */
const LATIN = /[A-Za-z]/;

const problems = [];
function check(condition, message) {
  if (!condition) problems.push(message);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 第一个中文出现的下标；没有则 -1。 */
function firstCjkIndex(text) {
  const m = text.search(CJK);
  return m;
}

/** 第一个拉丁字母出现的下标；没有则 -1。 */
function firstLatinIndex(text) {
  const m = text.search(LATIN);
  return m;
}

/**
 * 「中文优先」的可检查定义：有中文、有英文、且中文先出现。
 * 只要求中文先出现，不要求英文字数——描述长度归人管，测试不上价值判断。
 */
function bilingualChineseFirst(text, label) {
  const zh = firstCjkIndex(text);
  const en = firstLatinIndex(text);
  check(zh >= 0, `${label} 缺少中文`);
  check(en >= 0, `${label} 缺少英文`);
  check(zh < 0 || en < 0 || zh < en, `${label} 必须中文在前、英文在后（当前中文@${zh}、英文@${en}）`);
}

/** 去掉围栏代码块后的行（围栏里的 # 是命令注释，不是标题）。 */
function linesOutsideFences(text) {
  const out = [];
  let fence = null;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m !== null) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (fence === null) out.push({ line, number: i + 1 });
  }
  return out;
}

/** 英文词数（只数纯拉丁词，跳过路径、命令、代码）。 */
function englishWordCount(line) {
  return line
    .split(/\s+/)
    .filter((token) => /^[A-Za-z][A-Za-z'-]*$/.test(token)).length;
}

// ---------------------------------------------------------------- package.json

const pkg = JSON.parse(read('package.json'));
check(typeof pkg.description === 'string' && pkg.description.length > 0, 'package.json 必须有 description');
bilingualChineseFirst(String(pkg.description ?? ''), 'package.json 的 description');

// ---------------------------------------------------------------- README.md

const readme = read('README.md');

// 标题（一、二、三级）在代码块之外必须中英并列：`## 中文 / English`。
// 这是「尽量中英双语」的可执行版本——标题是读者第一个会扫的东西。
const headings = linesOutsideFences(readme).filter((entry) => /^#{1,3} /.test(entry.line));
check(headings.length >= 10, `README 标题数异常（${headings.length}），可能解析错了`);
for (const { line, number } of headings) {
  check(CJK.test(line), `README.md:${number} 标题缺少中文：${line}`);
  check(LATIN.test(line), `README.md:${number} 标题缺少英文：${line}`);
}

// 开头的摘要块引用必须中英各至少一段，且中文段在前。
const firstFifty = readme.split(/\r?\n/).slice(0, 50);
const quotes = firstFifty.filter((line) => /^>\s*\S/.test(line));
const zhQuotes = quotes.filter((line) => CJK.test(line));
const enQuotes = quotes.filter((line) => !CJK.test(line) && englishWordCount(line) >= 8);
check(zhQuotes.length >= 3, `README 开头的中文摘要太少（${zhQuotes.length} 行）`);
check(enQuotes.length >= 3, `README 开头缺少英文摘要（只有 ${enQuotes.length} 行 ≥8 词的英文块引用）`);
const firstZhQuote = quotes.findIndex((line) => CJK.test(line));
const firstEnQuote = quotes.findIndex((line) => !CJK.test(line) && englishWordCount(line) >= 8);
check(
  firstZhQuote >= 0 && firstEnQuote >= 0 && firstZhQuote < firstEnQuote,
  `README 开头的摘要必须中文在前、英文在后（中文首行@${firstZhQuote}、英文首行@${firstEnQuote}）`,
);

// 必须有一个纯英文的概览小节，给只读英文的人一条完整入口。
// 标题本身同样遵守「中文 / English」并列，所以只要求标题里有 `English` 这个词。
check(
  /^#{2,3}\s*.*\bEnglish\b/m.test(readme),
  'README 缺少一个英文概览小节（标题里应含 `English`，例如 `## 英文概览 / English overview`）',
);

// ---------------------------------------------------------------- 其它对外文件

bilingualChineseFirst(read('.github/SECURITY.md'), '.github/SECURITY.md');

const templateFiles = fs.readdirSync(path.join(ROOT, '.github/ISSUE_TEMPLATE')).filter((name) => name.endsWith('.yml'));
check(templateFiles.length >= 2, `issue 模板数异常（${templateFiles.length}）`);
for (const name of templateFiles) {
  const text = read(`.github/ISSUE_TEMPLATE/${name}`);
  check(CJK.test(text), `.github/ISSUE_TEMPLATE/${name} 缺少中文`);
  check(LATIN.test(text), `.github/ISSUE_TEMPLATE/${name} 缺少英文`);
}

bilingualChineseFirst(read('.github/pull_request_template.md'), '.github/pull_request_template.md');

// ---------------------------------------------------------------- docs/ 下的两份工程文档
//
// 这两份是内部工程记录，正文保持中文（不要求逐段英文——那会把 1700 多行的记录变成双语对照本，
// 收益远小于维护成本）。但它们同样在 GitHub 上被人点开，所以要求「入口层」双语：
// 一级标题、二级标题（章目录）、以及开头的摘要块。

for (const name of ['docs/设计与实施方案.md', 'docs/运维手册与变更记录.md']) {
  const text = read(name);
  const entryHeadings = linesOutsideFences(text).filter((entry) => /^#{1,2} /.test(entry.line));
  check(entryHeadings.length >= 5, `${name} 的章标题数异常（${entryHeadings.length}），可能解析错了`);
  for (const { line, number } of entryHeadings) {
    check(CJK.test(line), `${name}:${number} 章标题缺少中文：${line}`);
    check(LATIN.test(line), `${name}:${number} 章标题缺少英文：${line}`);
  }

  // 开头摘要：中文段之后要跟至少两行英文，否则英文读者点进来仍是一堵中文墙。
  const openingQuotes = text
    .split(/\r?\n/)
    .slice(0, 40)
    .filter((line) => /^>\s*\S/.test(line));
  const enOpening = openingQuotes.filter((line) => !CJK.test(line) && englishWordCount(line) >= 6);
  check(enOpening.length >= 2, `${name} 开头缺少英文摘要（只有 ${enOpening.length} 行 ≥6 词的英文块引用）`);
  const firstZh = openingQuotes.findIndex((line) => CJK.test(line));
  const firstEn = openingQuotes.findIndex((line) => !CJK.test(line) && englishWordCount(line) >= 6);
  check(
    firstZh >= 0 && firstEn >= 0 && firstZh < firstEn,
    `${name} 开头的摘要必须中文在前、英文在后（中文首行@${firstZh}、英文首行@${firstEn}）`,
  );
}

// ---------------------------------------------------------------- 结果

if (problems.length === 0) {
  console.log(`OK all docs assertions passed（${headings.length} 个标题中英并列，${quotes.length} 段摘要分中英）`);
} else {
  console.error(`FAIL: ${problems.length} 处：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}
