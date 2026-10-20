/**
 * dialog-fence — 对话级「围栏」规则注入插件
 *
 * 设计红线（用户 CR-01 的四条要求）：
 *  1. 不影响其他对话：通用规则对所有对话生效，会话规则只叠加到指定会话；
 *     没有任何规则时渲染空字符串，renderContextSections 会过滤掉空段 = 零 token 零影响。
 *  2. 不破坏缓存命中：只注册一个 systemPrompt.context()（运行时上下文段），
 *     绝不注册/修改系统提示词段。运行时快照由 agent-loop 以「纯追加一条 user 消息」
 *     的方式落历史，已有的请求前缀永远不被重写。
 *  3. 尽可能省上下文：文本不变时 RuntimeContextProjection.project() 返回 undefined，
 *     一条消息都不追加；文本变了才追加一份新快照。空规则 = 零字节。
 *  4. billion-context 兼容：注入落在「Current runtime context」快照里，被其
 *     dshDurableToolPath 归为 durable/runtime-context，自动进 protectedLatestTools
 *     （只保护最新一份），旧快照可被压缩，围栏常驻且不膨胀。
 *
 * 存储形态（0.7.0 起）：**单个 JSON 文件**，用户可直接编辑内容：
 *   <DSH home>/dialog-fence/fence.json
 *   {
 *     "version": 3,
 *     "enabled": true,
 *     "rules": ["通用规则，对每个对话生效", "..."],
 *     "sessions": { "<sessionId>": { "enabled": true, "rules": ["只对该会话生效"] } }
 *   }
 *
 * 文件位置可由用户自定义：改写同目录的 location.json（{"file": "<绝对路径>"}），
 * 或用 /fence file <绝对路径> / 面板上的「更改位置」。指针文件位置固定，
 * 围栏文件本身想去哪就去哪。
 *
 * 0.6.x 及更早的多 txt 目录（rules/common/*.txt + rules/sessions/<id>/*.txt）
 * 会在首次启动时**自动迁移**进 fence.json；老文件不删除，留给用户自查。
 *
 * 零 import：不依赖裸包解析，只用 process.getBuiltinModule。
 */

const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const childProcess = process.getBuiltinModule('node:child_process');

const name = 'dialog-fence';
/**
 * 硬依赖只有 systemPrompt 与 commands：CLI / TUI / headless 三种形态都能装。
 * Web 专属的 HTTP 路由（给可视化面板用）通过 ctx.inject(['connection'], …) 挂载 ——
 * 服务出现才注册，永远不会去「猜」它是否已就绪（0.2.x 用 ctx.get 软取导致 404，
 * 因为 cordis 的 ctx.get 默认 strict=true，只返回已 ACTIVE 的服务）。
 */
const inject = ['systemPrompt', 'commands'];

/** 插件自身目录（按安装形态会变，不要用它存数据）。 */
const SELF_DIR = import.meta.dirname;

/**
 * 向上找出 DSH home：第一个同时含 profiles/ 与 sessions/ 的祖先目录。
 *
 * 为什么需要它：0.5.0 起本插件可以作为组合包被官方安装器装进
 * `<home>/profiles/.generations/live/<gen>/node_modules/dsh-dialog-fence/`，
 * 那个目录每次升级都会换一份新的快照副本 —— 数据若跟着 SELF_DIR 走就会丢。
 * 从该位置向上走：node_modules → live → .generations → profiles → <home>，
 * 只有 <home> 同时含 profiles/ 与 sessions/。
 * 开发态（file:/// 挂载在 <home>/dialog-fence）向上第一层就是 <home>。
 * @returns {string|null} 绝对路径，找不到返回 null。
 */
function resolveDshHome() {
  let dir = SELF_DIR;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      if (fs.existsSync(path.join(dir, 'profiles')) && fs.existsSync(path.join(dir, 'sessions'))) return dir;
    } catch {
      /* 权限不足等：继续向上 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const DSH_HOME = resolveDshHome();

/**
 * 围栏数据所在的「基目录」：默认 `<DSH home>/dialog-fence`，
 * 与 0.5/0.6 时代 file:/// 挂载时的路径完全一致。
 * 装进组合包快照后仍指向同一目录，升级换代不丢数据。
 *
 * DIALOG_FENCE_HOME 仅供测试指向临时目录（避免测试改到真实围栏）；
 * DIALOG_FENCE_DIR 是 0.6.x 的老变量，仍兼容（会被当作基目录 + /rules 的老布局）。
 */
function resolveBaseDir() {
  if (typeof process.env.DIALOG_FENCE_HOME === 'string' && process.env.DIALOG_FENCE_HOME.length > 0) return process.env.DIALOG_FENCE_HOME;
  if (DSH_HOME === null) return SELF_DIR;
  return path.join(DSH_HOME, 'dialog-fence');
}

const BASE_DIR = resolveBaseDir();

/** 0.6.x 及更早的数据目录（多 txt 形态），仅用于自动迁移。 */
const LEGACY_DIR =
  typeof process.env.DIALOG_FENCE_DIR === 'string' && process.env.DIALOG_FENCE_DIR.length > 0 ? process.env.DIALOG_FENCE_DIR : path.join(BASE_DIR, 'rules');

/** 位置指针：固定放在基目录，围栏文件本身可以去任意绝对路径。 */
const LOCATION_FILE = path.join(BASE_DIR, 'location.json');

const FENCE_VERSION = 3;

const CONTEXT_NAME = 'dialog-fence:rules';
/**
 * 运行时上下文的段序：内建只有 SANDBOX_POLICY=110 / APPROVAL_POLICY=115 /
 * SUBAGENT_DELEGATION=120。围栏是「策略层」，插在审批策略之后、委派之前。
 */
const CONTEXT_ORDER = 118;

/** 硬上限，防止规则膨胀把上下文吃掉。 */
const MAX_RULES = 40;
const MAX_TOTAL_CHARS = 2400;
const MAX_RULE_CHARS = 2000;

const HEADER = 'Dialog fence (user-set rules binding this conversation; a newer direct user instruction wins on conflict):';

// ---------------------------------------------------------------------------
// 围栏文件位置：默认 base/fence.json，可被 location.json 或环境变量改写
// ---------------------------------------------------------------------------

function readLocation() {
  try {
    const raw = fs.readFileSync(LOCATION_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.file === 'string' && path.isAbsolute(parsed.file)) return parsed.file;
  } catch {
    /* 没有指针 = 用默认位置 */
  }
  return null;
}

function writeLocation(file) {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  } catch {
    /* 已存在 */
  }
  const tmp = `${LOCATION_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ file }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, LOCATION_FILE);
}

/** 当前围栏文件绝对路径（每次询问，位置可随时变）。 */
function fenceFile() {
  if (typeof process.env.DIALOG_FENCE_FILE === 'string' && process.env.DIALOG_FENCE_FILE.length > 0) return process.env.DIALOG_FENCE_FILE;
  const located = readLocation();
  return located === null ? path.join(BASE_DIR, 'fence.json') : located;
}

/** 围栏文件所在目录（「打开文件夹」的目标）。 */
function fenceDir() {
  return path.dirname(fenceFile());
}

// ---------------------------------------------------------------------------
// 围栏数据：单文件 JSON
// ---------------------------------------------------------------------------

function emptyFence() {
  return { version: FENCE_VERSION, enabled: true, rules: [], sessions: {} };
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

function sanitizeSessionId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return '';
  if (trimmed === '.' || trimmed === '..') return '';
  // 只允许字母数字与 - _ . ；其余一律替换，杜绝路径穿越类问题。
  return trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 把任意解析结果收敛成合法围栏对象；不认识的结构一律丢弃。 */
function normalizeFence(parsed) {
  const fence = emptyFence();
  if (parsed === null || typeof parsed !== 'object') return fence;
  if (parsed.enabled === false) fence.enabled = false;
  if (Array.isArray(parsed.rules)) {
    for (const entry of parsed.rules) {
      const text = normalizeText(entry);
      if (text.length > 0) fence.rules.push(text);
    }
  }
  const sessions = parsed.sessions;
  if (sessions !== null && typeof sessions === 'object') {
    for (const [id, entry] of Object.entries(sessions)) {
      const safe = sanitizeSessionId(id);
      if (safe === '' || entry === null || typeof entry !== 'object') continue;
      const rules = [];
      if (Array.isArray(entry.rules)) {
        for (const value of entry.rules) {
          const text = normalizeText(value);
          if (text.length > 0) rules.push(text);
        }
      }
      fence.sessions[safe] = { enabled: entry.enabled !== false, rules };
    }
  }
  return fence;
}

let fenceCache = { mtimeMs: -1, size: -1, fence: null };

function loadFence() {
  const file = fenceFile();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fenceCache = { mtimeMs: -1, size: -1, fence: null };
    return emptyFence();
  }
  if (fenceCache.fence !== null && fenceCache.mtimeMs === stat.mtimeMs && fenceCache.size === stat.size) return fenceCache.fence;
  let fence = emptyFence();
  try {
    // PowerShell 5.1 的 Set-Content / Out-File 默认写 UTF-16LE 或带 BOM 的 UTF-8，
    // 两种情况 JSON.parse 都会抛错，进而把整个围栏静默清空（本项目踩过一次）。
    const buf = fs.readFileSync(file);
    let raw = buf.toString('utf8');
    if (raw.includes('\u0000')) raw = buf.toString('utf16le');
    raw = raw.replace(/^\uFEFF/, '').replace(/^\0+/, '');
    fence = normalizeFence(JSON.parse(raw));
  } catch (error) {
    console.warn(`[dialog-fence] 围栏文件解析失败，本轮按空围栏处理（文件未被改写）: ${error?.message ?? error}`);
    fence = emptyFence();
  }
  fenceCache = { mtimeMs: stat.mtimeMs, size: stat.size, fence };
  return fence;
}

/** 原子写盘：先写 .tmp 再 rename，避免半截 JSON 卡死后续装配。 */
function saveFence(fence) {
  const file = fenceFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  const body = `${JSON.stringify(fence, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  try {
    const stat = fs.statSync(file);
    fenceCache = { mtimeMs: stat.mtimeMs, size: stat.size, fence };
  } catch {
    fenceCache = { mtimeMs: -1, size: -1, fence: null };
  }
}

// ---------------------------------------------------------------------------
// 0.6.x 多 txt 目录 → 单文件迁移
// ---------------------------------------------------------------------------

const RULE_FILE_PATTERN = /\.txt$/i;

function readTextFile(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    let text = buf.toString('utf8');
    if (text.includes('\u0000')) text = buf.toString('utf16le');
    return normalizeText(text.replace(/^\uFEFF/, '').replace(/^\0+/, ''));
  } catch {
    return '';
  }
}

/** 读出某个目录下的全部 txt（按文件名数字顺序），跳过空白。 */
function readTextDir(dir) {
  if (dir === '') return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((entry) => RULE_FILE_PATTERN.test(entry))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
    .map((file) => readTextFile(path.join(dir, file)))
    .filter((text) => text.length > 0);
}

function readLegacyState() {
  const file = path.join(LEGACY_DIR, 'state.json');
  try {
    const buf = fs.readFileSync(file);
    let raw = buf.toString('utf8');
    if (raw.includes('\u0000')) raw = buf.toString('utf16le');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').replace(/^\0+/, ''));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 首次启动时把老的多 txt 形态迁移成单文件。
 * 触发的两种情形：
 *   1) 围栏文件还不存在（全新安装）；
 *   2) 围栏文件存在但**是空的**（没有任何规则、没有任何会话），
 *      而老目录里有内容 —— 0.7.0 首次实装就是这种情况：启动时先落了空文件，
 *      随后才想起来去读老目录，结果 10 条通用规则一直没搬过来。
 * 老文件保持原样不删；围栏文件里一旦有用户数据就绝不覆盖。
 */
function migrateLegacyIfNeeded() {
  const file = fenceFile();
  let exists = false;
  try {
    exists = fs.existsSync(file);
  } catch {
    /* 探测失败就不要迁移，避免在异常环境里乱写 */
    return;
  }
  if (exists) {
    const current = loadFence();
    const empty = commonRules(current).length === 0 && Object.keys(current.sessions ?? {}).length === 0;
    if (!empty) return;
  }
  let legacyExists = false;
  try {
    legacyExists = fs.existsSync(path.join(LEGACY_DIR, 'common')) || fs.existsSync(path.join(LEGACY_DIR, 'sessions'));
  } catch {
    legacyExists = false;
  }
  if (!legacyExists) return;

  const legacyState = readLegacyState();
  const fence = emptyFence();
  if (legacyState?.global?.enabled === false) fence.enabled = false;
  fence.rules = readTextDir(path.join(LEGACY_DIR, 'common'));
  if (fence.rules.length === 0 && legacyState?.sessions === undefined) {
    let anySession = false;
    try {
      anySession = fs.readdirSync(path.join(LEGACY_DIR, 'sessions')).length > 0;
    } catch {
      anySession = false;
    }
    if (!anySession) return;
  }

  let sessionsDir = [];
  try {
    sessionsDir = fs.readdirSync(path.join(LEGACY_DIR, 'sessions'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    sessionsDir = [];
  }
  const ids = new Set(sessionsDir);
  if (legacyState?.sessions !== null && typeof legacyState?.sessions === 'object') for (const id of Object.keys(legacyState.sessions)) ids.add(id);
  for (const id of ids) {
    const safe = sanitizeSessionId(id);
    if (safe === '') continue;
    const rules = readTextDir(path.join(LEGACY_DIR, 'sessions', safe));
    const explicit = legacyState?.sessions?.[safe];
    const enabled = explicit === undefined ? rules.length > 0 : explicit?.enabled !== false;
    if (rules.length === 0 && explicit === undefined) continue;
    fence.sessions[safe] = { enabled, rules };
  }

  try {
    saveFence(fence);
    console.log(`[dialog-fence] 已从多 txt 目录迁移到单文件: ${file}（老文件保留在 ${LEGACY_DIR}）`);
  } catch (error) {
    console.warn(`[dialog-fence] 迁移失败，继续使用老目录: ${error?.message ?? error}`);
  }
}

// ---------------------------------------------------------------------------
// 规则的增删改查（统一在内存对象上做，写盘在调用方）
// ---------------------------------------------------------------------------

/** 通用规则（对每个对话生效）。 */
function commonRules(fence) {
  return Array.isArray(fence.rules) ? fence.rules : [];
}

/** 某个会话的专属规则；会话在 sessions 里没有条目时返回空数组。 */
function sessionRules(fence, sessionId) {
  const entry = fence.sessions?.[sessionId];
  return entry !== undefined && Array.isArray(entry.rules) ? entry.rules : [];
}

function sessionEntry(fence, sessionId) {
  if (fence.sessions[sessionId] === undefined) fence.sessions[sessionId] = { enabled: true, rules: [] };
  if (!Array.isArray(fence.sessions[sessionId].rules)) fence.sessions[sessionId].rules = [];
  return fence.sessions[sessionId];
}

// ---------------------------------------------------------------------------
// 渲染：把规则拼成交给模型的文本。空 = 什么都不注入。
// ---------------------------------------------------------------------------

function renderRuleTexts(texts) {
  if (texts.length === 0) return '';
  const lines = [HEADER];
  let used = HEADER.length;
  let shown = 0;
  for (const text of texts) {
    if (shown >= MAX_RULES) break;
    const line = `${shown + 1}. ${text}`;
    if (used + line.length + 1 > MAX_TOTAL_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown === 0) return '';
  if (shown < texts.length) lines.push(`(fence truncated: ${shown}/${texts.length} rules shown)`);
  return lines.join('\n');
}

function tokenEstimate(text) {
  return Math.ceil(text.length / 4);
}

/**
 * 从 AssembleContext 里取会话 id。
 * agent-loop 的 assembleContextFor() = { agent, scope: agent, signal }，
 * Actor 的公开形态是 { id: SessionId }。取不到就返回 ''（= 不注入）。
 */
function sessionIdOf(assembleContext) {
  const scope = assembleContext?.scope ?? assembleContext?.agent;
  const id = scope?.id;
  return typeof id === 'string' && id.length > 0 ? id : '';
}

/** 会话层是否启用：有显式条目以它为准，否则「有会话专属规则」即启用。 */
function isSessionEnabled(fence, sessionId, rules) {
  const entry = fence.sessions[sessionId];
  if (entry !== undefined) return entry.enabled !== false && rules.length > 0;
  return rules.length > 0;
}

/**
 * 实际注入的规则正文 = 通用规则（每个对话都有）+ 本会话专属规则。
 * 通用规则先编号，会话规则接在后面。总开关关掉时一律不注入。
 */
function fenceTextFor(sessionId) {
  if (sessionId === '') return '';
  const fence = loadFence();
  if (fence.enabled !== true) return '';
  const texts = [...commonRules(fence)];
  const own = sessionRules(fence, sessionId);
  if (isSessionEnabled(fence, sessionId, own)) texts.push(...own);
  return renderRuleTexts(texts);
}

// ---------------------------------------------------------------------------
// 可视化面板 / 设置页：宿主侧 HTTP 路由（仅 Web / Desktop 形态提供）
// 走 connection.fetch.register：自带同源鉴权与 token 校验，比裸 webServer 安全。
// ---------------------------------------------------------------------------

const API_PATH = '/api/dialog-fence';

function jsonResponse(payload, status = 200) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const LIMITS = { maxRules: MAX_RULES, maxTotalChars: MAX_TOTAL_CHARS, maxRuleChars: MAX_RULE_CHARS };

/** 把规则数组投影成带稳定序号的列表，供面板渲染与按序号增删改。 */
function rulesView(texts) {
  return texts.map((text, index) => ({ index, text }));
}

function fileInfo() {
  const file = fenceFile();
  return { file, dir: path.dirname(file), locationFile: LOCATION_FILE, legacyDir: LEGACY_DIR };
}

/** 通用规则层的快照（设置页主视图就是它）。 */
function commonSnapshotOf() {
  const fence = loadFence();
  const rules = rulesView(commonRules(fence));
  const rendered = fence.enabled === true ? renderRuleTexts(commonRules(fence)) : '';
  return {
    ok: true,
    scope: 'common',
    enabled: fence.enabled === true,
    rules,
    rendered,
    chars: rendered.length,
    tokens: tokenEstimate(rendered),
    ...fileInfo(),
    limits: LIMITS,
  };
}

/** 单个会话的快照（面板用）。也带上通用层，因为两者一起才是真实注入文本。 */
function snapshotOf(sessionId) {
  const fence = loadFence();
  const own = sessionRules(fence, sessionId);
  const rendered = fenceTextFor(sessionId);
  return {
    ok: true,
    scope: 'session',
    sessionId,
    enabled: isSessionEnabled(fence, sessionId, own),
    globalEnabled: fence.enabled === true,
    common: { rules: rulesView(commonRules(fence)), ...fileInfo() },
    rules: rulesView(own),
    rendered,
    chars: rendered.length,
    tokens: tokenEstimate(rendered),
    ...fileInfo(),
    limits: LIMITS,
  };
}

/** 会话清单（面板用；不作为设置页主视图）。 */
function knownSessions(fence) {
  const rows = [];
  for (const [sessionId, entry] of Object.entries(fence.sessions ?? {})) {
    if (sanitizeSessionId(sessionId) === '') continue;
    const rules = Array.isArray(entry?.rules) ? entry.rules : [];
    rows.push({
      sessionId,
      enabled: entry?.enabled !== false && rules.length > 0,
      ruleCount: rules.length,
      chars: rules.reduce((sum, text) => sum + text.length, 0),
    });
  }
  rows.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return rows;
}

/** 设置页快照（插件页那一栏用）。主视图是通用规则层。 */
function overviewOf() {
  const fence = loadFence();
  const common = rulesView(commonRules(fence));
  const rendered = fence.enabled === true ? renderRuleTexts(commonRules(fence)) : '';
  return {
    ok: true,
    globalEnabled: fence.enabled === true,
    common: {
      rules: common,
      rendered,
      chars: rendered.length,
      tokens: tokenEstimate(rendered),
      ...fileInfo(),
    },
    dataDir: path.dirname(fenceFile()),
    ...fileInfo(),
    sessions: knownSessions(fence),
    limits: LIMITS,
  };
}

/**
 * 上一次 spawn 的**异步**失败。
 * spawn 的失败是子进程对象上的 'error' 事件，晚于函数返回，同步的 try/catch 永远抓不到；
 * 这里把它记下来，下一次调用时报告，避免「明明启动失败却永远显示成功」。
 */
let lastOpenFailure = null;

/** 打开围栏文件所在文件夹（桌面形态可用；测试用 DIALOG_FENCE_NO_OPEN 关掉）。 */
function openFolder(target) {
  const dir = path.dirname(target);
  if (process.env.DIALOG_FENCE_NO_OPEN === '1') return { ok: true, opened: false, dir, reason: 'test-mode' };
  const previousFailure = lastOpenFailure;
  lastOpenFailure = null;
  try {
    // windowsHide: false —— 显式声明不要隐藏子进程窗口。
    // 实测（%TEMP% 隔离探针）：windowsHide:true 时 explorer 窗口会被创建但 IsWindowVisible=false
    // （style 0x4CF0000，缺 WS_VISIBLE），false 与不填则可见（style 0x14CF0000）。
    const options = { detached: true, stdio: 'ignore', windowsHide: false };
    let child = null;
    if (process.platform === 'win32') {
      // /select 会打开资源管理器并选中该文件；文件不存在时退化为打开目录。
      const args = fs.existsSync(target) ? ['/select,', target] : [dir];
      child = childProcess.spawn('explorer.exe', args, options);
    } else if (process.platform === 'darwin') {
      child = childProcess.spawn('open', ['-R', target], options);
    } else {
      child = childProcess.spawn('xdg-open', [dir], options);
    }
    // 挂上 'error' 监听：既把失败记录下来，也避免 ENOENT 变成未捕获的 'error' 事件把宿主打崩。
    if (child !== null && typeof child.on === 'function') {
      child.on('error', (error) => {
        lastOpenFailure = `无法打开文件夹: ${error?.message ?? error}`;
      });
    }
    if (child !== null && typeof child.unref === 'function') child.unref();
    if (previousFailure !== null) return { ok: true, opened: true, dir, warning: previousFailure };
    return { ok: true, opened: true, dir };
  } catch (error) {
    return { ok: false, error: `无法打开文件夹: ${error?.message ?? error}`, dir };
  }
}

/** openFolder 结果的附加说明（给 /fence open 的文本输出用）。 */
function openNotes(opened) {
  if (opened.reason === 'test-mode') return '\n\n（测试模式：DIALOG_FENCE_NO_OPEN=1，未真的打开窗口）';
  if (typeof opened.warning === 'string' && opened.warning.length > 0) return `\n\n注意：上一次打开失败 —— ${opened.warning}`;
  return '';
}

/** 把围栏文件搬到新位置，并把 location.json 指针指过去。 */
function moveFenceFile(target) {
  if (typeof target !== 'string' || target.trim().length === 0) return { ok: false, error: '需要绝对路径' };
  const resolved = target.trim();
  if (!path.isAbsolute(resolved)) return { ok: false, error: '必须使用绝对路径（例如 D:\\我的围栏\\fence.json）' };
  let finalPath = resolved;
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) finalPath = path.join(resolved, 'fence.json');
  } catch {
    /* 探测失败就按文件路径处理 */
  }
  if (!/\.json$/i.test(finalPath)) return { ok: false, error: '目标文件名需以 .json 结尾' };
  const current = fenceFile();
  try {
    if (path.resolve(finalPath) !== path.resolve(current)) {
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      if (!fs.existsSync(finalPath)) {
        // 把当前数据搬过去；目标已存在则不覆盖，直接切换（用户显式指定）。
        const fence = loadFence();
        fs.writeFileSync(finalPath, `${JSON.stringify(fence, null, 2)}\n`, 'utf8');
      }
      writeLocation(finalPath);
      fenceCache = { mtimeMs: -1, size: -1, fence: null };
    }
  } catch (error) {
    return { ok: false, error: `切换位置失败: ${error?.message ?? error}` };
  }
  return { ok: true, ...fileInfo() };
}

/** 面板提交的动作；与 /fence 命令共用同一个文件，改完下一轮即生效。 */
function applyAction(sessionId, action, payload) {
  const fence = loadFence();
  const scope = payload?.scope === 'common' ? 'common' : 'session';
  const texts = scope === 'common' ? commonRules(fence) : null;

  // 总开关与任何会话无关，必须在会话 id 校验之前处理。
  if (action === 'toggleGlobal' || action === 'switch') {
    fence.enabled = payload.enabled !== false;
    saveFence(fence);
    return overviewOf();
  }
  if (action === 'setFile') {
    const moved = moveFenceFile(typeof payload.file === 'string' ? payload.file : '');
    if (moved.ok === false) return { ok: false, error: moved.error };
    return overviewOf();
  }
  if (action === 'openFolder') {
    const opened = openFolder(fenceFile());
    if (opened.ok === false) return { ok: false, error: opened.error };
    return {
      ...overviewOf(),
      opened: opened.opened === true,
      openReason: opened.reason ?? null,
      // 上一轮 spawn 的异步失败：由这里带到前端，否则失败对用户永远不可见。
      openWarning: opened.warning ?? null,
    };
  }

  if (scope === 'session' && sessionId === '') return { ok: false, error: '缺少会话 id' };
  // 必须拿到**挂在 fence 上的那个数组**：sessionRules() 在会话没有条目时返回的是临时空数组，
  // 往里 push 改不到 fence（0.7.0 首次实现的 bug：新会话 add 静默无效）。
  const list = scope === 'common' ? texts : sessionEntry(fence, sessionId).rules;

  if (action === 'toggle') {
    if (scope === 'common') {
      fence.enabled = payload.enabled !== false;
    } else {
      sessionEntry(fence, sessionId).enabled = payload.enabled !== false;
    }
    saveFence(fence);
    return scope === 'common' ? commonSnapshotOf() : snapshotOf(sessionId);
  }

  const pushText = (text) => {
    if (text.length === 0) return '规则文本不能为空';
    if (text.length > MAX_RULE_CHARS) return `单条规则最多 ${MAX_RULE_CHARS} 字符（当前 ${text.length}）`;
    if (list.some((existing) => existing === text)) return '';
    if (list.length >= MAX_RULES) return `规则已达上限 ${MAX_RULES} 条`;
    list.push(text);
    return '';
  };

  if (action === 'add') {
    const error = pushText(normalizeText(payload.text));
    if (error !== '') return { ok: false, error };
    if (scope === 'session') sessionEntry(fence, sessionId).enabled = true;
    saveFence(fence);
    return scope === 'common' ? commonSnapshotOf() : snapshotOf(sessionId);
  }

  const index = Number.parseInt(String(payload.index ?? ''), 10);
  const valid = Number.isInteger(index) && index >= 0 && index < list.length;

  if (action === 'update') {
    if (!valid) return { ok: false, error: `没有第 ${payload.index} 条规则` };
    const text = normalizeText(payload.text);
    if (text.length === 0) return { ok: false, error: '规则文本不能为空' };
    if (text.length > MAX_RULE_CHARS) return { ok: false, error: `单条规则最多 ${MAX_RULE_CHARS} 字符（当前 ${text.length}）` };
    list[index] = text;
    saveFence(fence);
    return scope === 'common' ? commonSnapshotOf() : snapshotOf(sessionId);
  }
  if (action === 'remove') {
    if (!valid) return { ok: false, error: `没有第 ${payload.index} 条规则` };
    list.splice(index, 1);
    saveFence(fence);
    return scope === 'common' ? commonSnapshotOf() : snapshotOf(sessionId);
  }
  if (action === 'clear') {
    list.length = 0;
    saveFence(fence);
    return scope === 'common' ? commonSnapshotOf() : snapshotOf(sessionId);
  }
  if (action === 'reset') {
    if (scope === 'common') {
      fence.rules = [];
    } else {
      delete fence.sessions[sessionId];
    }
    saveFence(fence);
    return scope === 'common' ? commonSnapshotOf() : snapshotOf(sessionId);
  }
  return { ok: false, error: `未知动作 ${action}` };
}

async function handleApi(request) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const url = new URL(request.url);
    const rawSession = url.searchParams.get('sessionId');
    const rawScope = url.searchParams.get('scope');
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
    if (rawScope === 'common') return jsonResponse(commonSnapshotOf());
    if (rawSession === null || rawSession === '') return jsonResponse(overviewOf());
    const sessionId = sanitizeSessionId(rawSession);
    if (sessionId === '') return jsonResponse({ ok: false, error: '非法的 sessionId' }, 400);
    return jsonResponse(snapshotOf(sessionId));
  }
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method not allowed' }, 405);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return jsonResponse({ ok: false, error: '请求体必须是 JSON' }, 400);
  }
  const action = typeof body?.action === 'string' ? body.action : '';
  if (action === 'toggleGlobal' || action === 'switch' || action === 'setFile' || action === 'openFolder') {
    const snapshot = applyAction('', action, body ?? {});
    return snapshot.ok === false ? jsonResponse(snapshot, 400) : jsonResponse(snapshot);
  }
  // 通用规则层：不需要 sessionId。
  if (body?.scope === 'common') {
    const snapshot = applyAction('', action, body ?? {});
    return snapshot.ok === false ? jsonResponse(snapshot, 400) : jsonResponse(snapshot);
  }
  const sessionId = sanitizeSessionId(body?.sessionId);
  if (sessionId === '') return jsonResponse({ ok: false, error: '缺少或非法的 sessionId' }, 400);
  const snapshot = applyAction(sessionId, action, body ?? {});
  return snapshot.ok === false ? jsonResponse(snapshot, 400) : jsonResponse(snapshot);
}

// ---------------------------------------------------------------------------
// 命令：/fence
// ---------------------------------------------------------------------------

function fileLinesFor(prefix) {
  return [
    `${prefix}围栏文件: ${fenceFile()}`,
    `${prefix}所在目录: ${fenceDir()}`,
    `${prefix}位置指针: ${LOCATION_FILE}`,
  ];
}

function statusText(sessionId) {
  const fence = loadFence();
  const own = sessionRules(fence, sessionId);
  const common = commonRules(fence);
  const enabled = isSessionEnabled(fence, sessionId, own);
  const text = fenceTextFor(sessionId);
  const lines = [
    `/fence status — 会话 ${sessionId}`,
    `总开关: ${fence.enabled === true ? '开' : '关（所有对话都不注入）'}`,
    `通用规则: ${common.length} 条（对所有对话生效）`,
    `本会话: ${enabled ? '已启用' : '未启用（本会话专属规则不注入）'}`,
    `本会话专属规则: ${own.length} 条`,
    `实际注入: ${text.length} 字符 ≈ ${tokenEstimate(text)} token`,
    ...fileLinesFor(''),
  ];
  if (common.length > 0) {
    lines.push('通用规则清单:');
    common.forEach((text, index) => lines.push(`  ${index + 1}. ${text}`));
  }
  if (own.length > 0) {
    lines.push('本会话专属规则清单:');
    own.forEach((text, index) => lines.push(`  ${index + 1}. ${text}`));
  }
  if (text.length > 0) {
    lines.push('实际注入（每次快照变化才重新追加一次）:');
    lines.push('---8<---');
    lines.push(text);
    lines.push('--->8---');
  }
  return lines.join('\n');
}

const HELP = [
  '/fence                      显示状态',
  '/fence on | off             启用 / 停用本会话专属规则',
  '/fence add <规则文本>       新建一条本会话专属规则',
  '/fence rm <序号>            删除第 N 条本会话专属规则',
  '/fence clear                清空本会话专属规则',
  '/fence reset                清空本会话规则并删除开关登记',
  '/fence dir                  显示围栏文件路径',
  '',
  '/fence all                  显示通用规则（对每个对话都生效）',
  '/fence all add <规则文本>   新建一条通用规则',
  '/fence all rm <序号>        删除第 N 条通用规则',
  '/fence all clear            清空通用规则',
  '',
  '/fence switch on | off      总开关（关掉后所有对话都不注入）',
  '/fence file <绝对路径>      把围栏文件换到别的位置',
  '/fence open                 打开围栏文件所在文件夹',
  '',
  '全部规则都存在同一个 JSON 文件里（默认 <home>/dialog-fence/fence.json），',
  '可以直接用任何编辑器改内容，下一轮生效。',
].join('\n');

function succeed(text) {
  return { kind: 'success', text };
}

function fail(text) {
  return { kind: 'error', text };
}

/** 通用规则层的命令（/fence all ...），作用域与当前会话无关。 */
function handleFenceCommon(argument) {
  const [verbRaw, ...rest] = argument.length === 0 ? [] : argument.split(/\s+/);
  const verb = (verbRaw ?? '').toLowerCase();
  const text = argument.length === 0 ? '' : argument.slice(verbRaw.length).trim();

  if (verb === '' || verb === 'status' || verb === 'show') return succeed(commonStatusText());
  if (verb === 'dir' || verb === 'file') return succeed(fileLinesFor('通用规则 ').join('\n'));
  if (verb === 'open') {
    const opened = openFolder(fenceFile());
    if (opened.ok === false) return fail(opened.error);
    const note = openNotes(opened);
    return succeed(`已打开围栏文件夹:\n${opened.dir}${note}`);
  }

  const fence = loadFence();
  const list = commonRules(fence);

  if (verb === 'add') {
    if (text.length === 0) return fail('/fence all add 需要规则文本');
    if (text.length > MAX_RULE_CHARS) return fail(`单条规则最多 ${MAX_RULE_CHARS} 字符（当前 ${text.length}）`);
    if (list.some((existing) => existing === text)) return succeed(`该通用规则已存在，未重复添加。\n${commonStatusText()}`);
    if (list.length >= MAX_RULES) return fail(`通用规则已达上限 ${MAX_RULES} 条`);
    list.push(text);
    saveFence(fence);
    return succeed(`已添加通用规则（第 ${list.length} 条）\n${commonStatusText()}`);
  }

  if (verb === 'rm' || verb === 'remove' || verb === 'del') {
    const index = Number.parseInt(text, 10);
    if (!Number.isInteger(index) || index < 1 || index > list.length) return fail(`/fence all rm 需要 1..${list.length} 之间的序号`);
    const removed = list.splice(index - 1, 1)[0];
    saveFence(fence);
    return succeed(`已删除通用规则: ${removed}\n${commonStatusText()}`);
  }

  if (verb === 'clear') {
    const removed = list.length;
    fence.rules = [];
    saveFence(fence);
    return succeed(`已清空 ${removed} 条通用规则。\n${commonStatusText()}`);
  }

  return fail(`未知子命令 "all ${verbRaw}"。\n${HELP}`);
}

function commonStatusText() {
  const fence = loadFence();
  const rules = commonRules(fence);
  const text = fence.enabled === true ? renderRuleTexts(rules) : '';
  const lines = [
    '/fence all — 通用规则（对每个对话都生效）',
    `总开关: ${fence.enabled === true ? '开' : '关（所有对话都不注入）'}`,
    `规则: ${rules.length} 条，注入文本 ${text.length} 字符 ≈ ${tokenEstimate(text)} token`,
    ...fileLinesFor(''),
  ];
  rules.forEach((rule, index) => lines.push(`  ${index + 1}. ${rule}`));
  return lines.join('\n');
}

function handleFence(invocation) {
  const sessionId = typeof invocation.agent?.id === 'string' ? invocation.agent.id : '';
  const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
  const [verbRaw] = raw.length === 0 ? [] : raw.split(/\s+/);
  const verb = (verbRaw ?? '').toLowerCase();
  const argument = raw.length === 0 ? '' : raw.slice(verbRaw.length).trim();

  // 通用规则层与当前会话无关，先分流。
  if (verb === 'all' || verb === 'common' || verb === 'global') return handleFenceCommon(argument);
  if (verb === 'help' || verb === '?') return succeed(HELP);

  // 总开关 / 换位置 / 打开文件夹都不需要会话 id。
  if (verb === 'switch') {
    const value = argument.toLowerCase();
    if (value !== 'on' && value !== 'off') return fail('/fence switch 需要 on 或 off');
    const fence = loadFence();
    fence.enabled = value === 'on';
    saveFence(fence);
    return succeed(commonStatusText());
  }
  if (verb === 'file' || verb === 'path') {
    if (argument.length === 0) return succeed(fileLinesFor('').join('\n'));
    const moved = moveFenceFile(argument);
    if (moved.ok === false) return fail(moved.error);
    return succeed(`围栏文件已切换到:\n${moved.file}\n\n所在目录:\n${moved.dir}`);
  }
  if (verb === 'open') {
    const opened = openFolder(fenceFile());
    if (opened.ok === false) return fail(opened.error);
    const note = openNotes(opened);
    return succeed(`已打开围栏文件夹:\n${opened.dir}\n\n围栏文件: ${fenceFile()}${note}`);
  }

  if (sessionId === '') return fail('/fence: 无法确定当前会话 id');

  const fence = loadFence();

  if (verb === '' || verb === 'status' || verb === 'show') return succeed(statusText(sessionId));
  if (verb === 'dir') return succeed(fileLinesFor('').join('\n'));

  if (verb === 'on' || verb === 'off') {
    sessionEntry(fence, sessionId).enabled = verb === 'on';
    saveFence(fence);
    return succeed(statusText(sessionId));
  }

  const own = sessionRules(fence, sessionId);

  if (verb === 'add') {
    if (argument.length === 0) return fail('/fence add 需要规则文本');
    if (argument.length > MAX_RULE_CHARS) return fail(`单条规则最多 ${MAX_RULE_CHARS} 字符（当前 ${argument.length}）`);
    if (own.some((existing) => existing === argument)) return succeed(`该规则已存在，未重复添加。\n${statusText(sessionId)}`);
    if (own.length >= MAX_RULES) return fail(`规则已达上限 ${MAX_RULES} 条，请先 /fence rm <序号>`);
    sessionEntry(fence, sessionId).rules.push(argument);
    sessionEntry(fence, sessionId).enabled = true;
    saveFence(fence);
    return succeed(`已添加本会话专属规则（第 ${own.length + 1} 条）\n${statusText(sessionId)}`);
  }

  if (verb === 'rm' || verb === 'remove' || verb === 'del') {
    const index = Number.parseInt(argument, 10);
    if (!Number.isInteger(index) || index < 1 || index > own.length) return fail(`/fence rm 需要 1..${own.length} 之间的序号`);
    const removed = own.splice(index - 1, 1)[0];
    saveFence(fence);
    return succeed(`已删除: ${removed}\n${statusText(sessionId)}`);
  }

  if (verb === 'clear') {
    const removed = own.length;
    sessionEntry(fence, sessionId).rules = [];
    saveFence(fence);
    return succeed(`已删除 ${removed} 条本会话专属规则。\n${statusText(sessionId)}`);
  }

  if (verb === 'reset') {
    const removed = own.length;
    delete fence.sessions[sessionId];
    saveFence(fence);
    return succeed(`已删除 ${removed} 条本会话专属规则并清除开关登记。\n${statusText(sessionId)}`);
  }

  return fail(`未知子命令 "${verbRaw}"。\n${HELP}`);
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

async function apply(ctx) {
  // 首次启动：建好基目录（用户点「打开文件夹」时能看到东西），并把老数据迁移过来。
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  } catch {
    /* 目录不可写时后面所有读写都会各自降级，这里不阻塞启动 */
  }
  migrateLegacyIfNeeded();
  // 围栏文件不存在时先落一份空的：用户点「打开文件夹」才看得到可编辑的文件。
  try {
    if (!fs.existsSync(fenceFile())) saveFence(loadFence());
  } catch {
    /* 写不了就等第一次真实写入 */
  }

  // 围栏文本：只读状态，异常一律降级为空字符串 —— 装配失败会直接毁掉整轮对话，
  // 这个 try/catch 是「不影响其他对话」这条红线的最后一道保险。
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text: (assembleContext) => {
          try {
            return fenceTextFor(sessionIdOf(assembleContext));
          } catch (error) {
            console.warn(`[dialog-fence] 装配围栏文本失败，已降级为空: ${error?.message ?? error}`);
            return '';
          }
        },
      }),
    'dialog-fence.context()',
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'fence',
        description: '围栏规则：给对话设置边界（通用规则对所有对话生效，全部规则存在一个 JSON 文件里）',
        input: { hint: '[on|off|add <文本>|rm <序号>|clear|reset|dir|status|all ...|switch on/off|file <路径>|open]' },
        handler: (invocation) => {
          try {
            return handleFence(invocation);
          } catch (error) {
            return fail(`/fence 执行失败: ${error?.message ?? error}`);
          }
        },
      }),
    'dialog-fence.command()',
  );

  // Web / Desktop 形态：注册面板与设置页用的 JSON 路由。
  // CLI / TUI / headless 没有 connection 服务，回调永远不会被触发（不报错）。
  //
  // 这里必须用 ctx.inject 而不是 ctx.get：cordis 的 ctx.get(name) 默认 strict=true，
  // 只返回 provider fiber 已 ACTIVE 的服务。插件 apply 往往早于 connection 激活，
  // 用 ctx.get 软取会拿到 undefined 并静默跳过注册 —— 面板于是收到 404
  // （0.2.x 的「左下角 HTTP 404」就是这个原因）。
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = typeof connectionCtx.get === 'function' ? connectionCtx.get('connection') : undefined;
    if (connection === undefined || typeof connection?.fetch?.register !== 'function') {
      console.warn('[dialog-fence] connection 服务缺少 fetch.register，可视化面板不可用');
      return;
    }
    connectionCtx.effect(
      () =>
        connection.fetch.register({
          path: API_PATH,
          methods: ['GET', 'HEAD', 'POST'],
          requestBody: 'buffered',
          fetch: handleApi,
        }),
      'dialog-fence.route()',
    );
    console.log(`[dialog-fence] route ready: ${API_PATH}`);
  });

  console.log(`[dialog-fence] ready: file=${fenceFile()} context=${CONTEXT_NAME}@${CONTEXT_ORDER}`);
}

export { apply, inject, name };
