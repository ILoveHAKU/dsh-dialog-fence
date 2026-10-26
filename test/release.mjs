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
assert.match(wf, /registry-url:\s*['"]?https:\/\/registry\.npmjs\.org\/?['"]?/, 'workflow sets the public registry');
assert.match(wf, /package-manager-cache:\s*false/, 'workflow disables the package-manager cache (release jobs must not restore a half state)');

// ---- 5) 真的会执行 publish ----
assert.match(wfCode, /\bnpm publish\b/, 'workflow runs npm publish');

// ---- 6) 关键红线：仓库里不得出现任何 npm 凭据 ----
// trusted publishing 的全部意义就是不用存 token；一旦出现 secret 引用就说明有人退回了老路。
assert.doesNotMatch(wfCode, /secrets\./, 'publish workflow references no repository secret at all');
assert.doesNotMatch(wfCode, /NPM_TOKEN|NODE_AUTH_TOKEN/, 'publish workflow has no NPM_TOKEN / NODE_AUTH_TOKEN reference');
assert.doesNotMatch(wfCode, /_authToken\s*=\s*\S/, 'publish workflow writes no literal _authToken');

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

// ---- 9) package.json 自身：可以被发布 ----
assert.equal(PKG.private, undefined, 'package.json is publishable (no "private": true)');
assert.match(PKG.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'package.json version is a valid semver');
assert.equal(PKG.repository.url, 'git+https://github.com/ILoveHAKU/dsh-dialog-fence.git', 'repository points at the listed repo (npm links the two)');
assert.ok(Array.isArray(PKG.files) && PKG.files.length > 0, 'package.json declares the files allow-list');

// ---- 10) 发布产物里不能混进本机运行数据 ----
// fence.json 是用户数据、assets/ 是文档截图（体积大），都不该进 tarball。
assert.ok(!PKG.files.includes('fence.json'), 'tarball allow-list excludes the local fence.json');
assert.ok(!PKG.files.some((f) => f.startsWith('assets')), 'tarball allow-list excludes assets/');

console.log('OK all dialog-fence release assertions passed');
