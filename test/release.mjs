// 发布通道的静态检查：确认「发 npm」这件事只有一条可复现的路径，而且这条路径不需要仓库里存任何凭据。
//
// 为什么要单独一个脚本：发布工作流最容易出的两个问题都看不见——
//   1) 有人图省事把 token 塞进 workflow 或 .npmrc（泄漏，且换机器就失效）；
//   2) workflow 里的 node/npm 版本低于 trusted publishing 的门槛（CI 绿、publish 403）。
// 这两类问题都不会让 `npm test` 变红，只能靠静态断言守住。
//
// 依据（npm 官方文档 https://docs.npmjs.com/trusted-publishers 原文）：
//   "Trusted publishing requires npm CLI version 11.5.1 or later and Node version 22.14.0 or higher."
//
// 跑法（与其它测试一致）：
//   node test/release.mjs
//   $env:ELECTRON_RUN_AS_NODE="1"; & "D:\DSH Desktop\DSH Desktop.exe" test\release.mjs
//
// 通过时打印 "OK all dialog-fence release assertions passed"，退出码 0；否则 exit 1。

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'publish.yml');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ---- 1) 发布工作流必须存在 ----
assert.ok(fs.existsSync(WORKFLOW), 'publish workflow exists at .github/workflows/publish.yml');
const wf = fs.readFileSync(WORKFLOW, 'utf8');

// 「真正生效的配置」= 剥掉 YAML 注释后的文本。注释里会写「不需要 NPM_TOKEN」这类说明，
// 按全文扫会把文档判成违规（本测试第一版就这么红了一次）。
const wfCode = wf
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '$1')) // 去掉行内注释（YAML 的 # 前必须有空白）
  .join('\n');

// ---- 2) 触发条件：打 tag 才发版，且允许手动触发 ----
assert.match(wf, /\bpush:\s*\n\s*tags:/, 'publish workflow triggers on tag push');
assert.match(wf, /-\s*['"]v\*['"]/, "publish workflow triggers on 'v*' tags");
assert.match(wf, /\bworkflow_dispatch:/, 'publish workflow can be dispatched by hand');

// ---- 3) OIDC 权限：trusted publishing 的必要条件，缺了会拿到 401 ----
assert.match(wf, /\n\s*permissions:\s*\n/, 'publish workflow declares permissions');
assert.match(wf, /id-token:\s*write/, 'publish workflow grants id-token: write (required for OIDC)');
assert.match(wf, /contents:\s*read/, 'publish workflow restricts contents to read');

// ---- 4) 版本门槛：低于这个版本 npm CLI 不会做 OIDC 交换 ----
assert.match(wf, /node-version:\s*['"]?(2[2-9]|[3-9]\d)(\.\d+)*['"]?/, 'workflow pins Node >= 22 (trusted publishing needs >= 22.14.0)');
assert.doesNotMatch(wf, /node-version:\s*['"]?(1\d|2[01])(\.|['"]|\s)/, 'workflow does not pin Node below 22');
assert.match(wf, /package-manager-cache:\s*false/, 'workflow disables the package-manager cache (release jobs must not restore a half state)');

// ---- 4b) 官方 action 必须用不依赖 node20 的主版本 ----
// GitHub 已弃用 node20 action：跑在 node24 上会出 annotation
//   "Node.js 20 is deprecated. The following actions target Node.js 20..."
// 而且 setup-node@v4 **没有** package-manager-cache 输入（v5 才加），
// 写了会被当成未知输入静默忽略 —— CI 绿但配置其实没生效。
const NODE24_ACTIONS = {
  'actions/checkout': 5, // v5 起 using: node24
  'actions/setup-node': 5, // v5 起 node24，且才支持 package-manager-cache
  'actions/upload-artifact': 6, // v6 起 node24
};
for (const [action, minMajor] of Object.entries(NODE24_ACTIONS)) {
  const pattern = new RegExp(`uses:\\s*${action.replace('/', '\\/')}@v(\\d+)`, 'g');
  const uses = [...wfCode.matchAll(pattern)];
  assert.ok(uses.length > 0, `workflow uses ${action}`);
  for (const m of uses) {
    const major = Number(m[1]);
    assert.ok(
      major >= minMajor,
      `${action}@v${major} still targets node20; use v${minMajor}+ (node24) to avoid the deprecation annotation`,
    );
  }
}

// setup-node 的 registry-url 会往 .npmrc 里写一行 `_authToken=${NODE_AUTH_TOKEN}`，
// 而 npm 一旦发现存在 _authToken 就会走 token 鉴权、不再做 OIDC 交换 —— trusted
// publishing 直接失效（实测表现：`npm error 404 PUT https://registry.npmjs.org/...`，
// 这个 404 还会掩盖「Trusted Publisher 根本没配」的真实原因）。
// 所以这条是**反向**断言：绝不能设 registry-url。
assert.doesNotMatch(
  wfCode,
  /registry-url:/,
  'workflow must not set setup-node registry-url (it injects NODE_AUTH_TOKEN and defeats trusted publishing)',
);
// 既然不靠 registry-url，就必须在 publish 时显式指定 registry，否则发到默认之外的地方
assert.match(
  wfCode,
  /npm publish\b[^\n]*--registry\s+https:\/\/registry\.npmjs\.org/,
  'npm publish explicitly targets the public registry',
);
// 保险：即使运行器里残留了 NODE_AUTH_TOKEN / .npmrc，也要在发布前清掉
assert.match(wfCode, /NODE_AUTH_TOKEN/, 'workflow defensively unsets NODE_AUTH_TOKEN before publishing');

// ---- 5) 真的会执行 publish ----
assert.match(wfCode, /\bnpm publish\b/, 'workflow runs npm publish');

// ---- 6) 关键红线：仓库里不得出现任何 npm 凭据 ----
// trusted publishing 的全部意义就是不用存 token；一旦出现 secret 引用就说明有人退回了老路。
assert.doesNotMatch(wfCode, /secrets\./, 'publish workflow references no repository secret at all');
assert.doesNotMatch(wfCode, /_authToken\s*=\s*\S/, 'publish workflow writes no literal _authToken');
// NODE_AUTH_TOKEN 只允许出现在「主动清除」的语句里（unset / 判断是否为空），
// 不允许被当成凭据赋值或透传。红线针对的是「把 token 当凭据用」，不是「提到这个名字」。
for (const line of wfCode.split('\n')) {
  if (!/NODE_AUTH_TOKEN/.test(line)) continue;
  assert.match(
    line,
    /^\s*(?:unset\s+NODE_AUTH_TOKEN|echo\s+["']?NODE_AUTH_TOKEN)/,
    `NODE_AUTH_TOKEN may only be unset or probed for emptiness, got: ${line.trim()}`,
  );
}

// ---- 7) 发版前必须先跑测试：避免把红灯版本推上 registry（registry 上的版本删不掉） ----
assert.match(wfCode, /\bnpm test\b/, 'publish workflow runs the test suite before publishing');
const testAt = wfCode.indexOf('npm test');
const publishAt = wfCode.indexOf('npm publish');
assert.ok(testAt >= 0 && publishAt >= 0 && testAt < publishAt, 'tests run before npm publish');

// ---- 8) tag 必须与 package.json 的版本一致，否则会发出一个跟 tag 对不上的版本 ----
assert.match(wf, /GITHUB_REF_NAME/, 'workflow compares the pushed tag with package.json version');
assert.match(wf, /version/, 'workflow reads package.json version for the tag guard');
// 手动 dispatch 时没有 tag（GITHUB_REF_NAME 是分支名），必须放行而不是报错，
// 否则「推 tag」和「手动 Run workflow」这两条路只能走通一条。
assert.match(wfCode, /GITHUB_REF_TYPE/, 'workflow tells a tag ref apart from a manual dispatch');
assert.match(
  wfCode,
  /GITHUB_REF_TYPE"?\s*!=\s*"?tag/,
  'manual dispatch (non-tag ref) skips the tag comparison instead of failing',
);
// ---- 8b) 手动 dispatch 必须能指定「从哪个 tag 发」，并在发布前把工作区对齐到它 ----
// 事故（0.12.0 真发生）：tag 打在 A 上，之后又推了几个 commit，然后手动 dispatch。
// 手动触发 checkout 的是分支 HEAD，于是「发出去的内容」不是 tag 指向的内容：
//   provenance.resolvedDependencies -> ...@<HEAD>，而 v0.12.0 -> <A>
// 后果是按 tag 重新打包得到另一个 shasum，tag 失去溯源意义。
// 修法：dispatch 时允许传 publish_ref（tag），checkout 必须用它而不是默认 ref，
// 并且发布前校验 HEAD 就是那个 tag。
assert.match(
  wfCode,
  /publish_ref/,
  'manual dispatch accepts publish_ref so a release can be built from a tag, not from branch HEAD',
);
assert.match(
  wfCode,
  /ref:\s*\$\{\{[^}]*publish_ref/,
  'checkout uses publish_ref (otherwise a manual dispatch publishes the branch head)',
);
assert.match(
  wfCode,
  /git\s+rev-parse\s+HEAD|git\s+describe|rev-list\s+-n\s*1/,
  'workflow verifies the checked-out commit really is the release tag before publishing',
);

// ---- 9) package.json 自身：可以被发布 ----
// 9b) 重复执行不应把「版本已存在」当成故障。
// 事故背景：移动一个 v* tag 会重新触发本 workflow；此时版本已在 registry 上，
// `npm publish` 必然报 E403，于是每次修正 tag 都会多出一封失败邮件。
// 因此发布前要先查「这个版本是否已发布」，已发布就跳过（而不是失败）。
assert.match(
  wfCode,
  /npm view\b[^\n]*version/,
  'workflow asks the registry whether the version already exists before publishing',
);
assert.match(
  wfCode,
  /skip[\s\S]{0,40}GITHUB_OUTPUT|GITHUB_OUTPUT[\s\S]{0,80}skip/,
  'workflow records a skip decision in GITHUB_OUTPUT',
);
assert.match(
  wfCode,
  /if:\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*!=\s*['"]true['"]|if:\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*==\s*['"]false['"]/,
  'the publish step is gated on that skip decision',
);

assert.equal(PKG.private, undefined, 'package.json is publishable (no "private": true)');
assert.match(PKG.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'package.json version is a valid semver');
assert.equal(PKG.repository.url, 'git+https://github.com/ILoveHAKU/dsh-dialog-fence.git', 'repository points at the listed repo (npm links the two)');
assert.ok(Array.isArray(PKG.files) && PKG.files.length > 0, 'package.json declares the files allow-list');

// ---- 10) 发布产物里不能混进本机运行数据 ----
// fence.json 是用户数据、assets/ 是文档截图（体积大），都不该进 tarball。
assert.ok(!PKG.files.includes('fence.json'), 'tarball allow-list excludes the local fence.json');
assert.ok(!PKG.files.some((f) => f.startsWith('assets')), 'tarball allow-list excludes assets/');

console.log('OK all dialog-fence release assertions passed');
