/**
 * dialog-fence — 会话级「围栏」规则注入插件
 *
 * 设计红线（用户 CR-01 的四条要求）：
 *  1. 不影响其他对话：规则按 sessionId 隔离，默认关闭；未启用的会话注入空字符串，
 *     renderContextSections 会过滤掉空段，因此对其它会话零 token 零影响。
 *  2. 不破坏缓存命中：只注册一个 systemPrompt.context()（运行时上下文段），
 *     绝不注册/修改系统提示词段。运行时快照由 agent-loop 以「纯追加一条 user 消息」
 *     的方式落历史，已有的请求前缀永远不被重写。
 *  3. 尽可能省上下文：文本不变时 RuntimeContextProjection.project() 返回 undefined，
 *     一条消息都不追加；文本变了才追加一份新快照。空规则 = 零字节。
 *  4. billion-context 兼容：注入落在「Current runtime context」快照里，被其
 *     dshDurableToolPath 归为 durable/runtime-context，自动进 protectedLatestTools
 *     （只保护最新一份），旧快照可被压缩，围栏常驻且不膨胀。
 *
 * 存储形态（0.3.0 起）：**每条规则一个 .txt 文件**，方便用任意编辑器随时增删改：
 *   <插件目录>/rules/sessions/<sessionId>/01-<slug>.txt
 *   <插件目录>/rules/sessions/<sessionId>/02-<slug>.txt
 *   <插件目录>/rules/state.json      ← 只存开关（全局 + 各会话），不存规则正文
 * 文件名前缀决定顺序；删文件即删规则；改文件内容即改规则。
 * 若某个会话在 state.json 里没有显式条目，则「目录里有 .txt」即视为启用
 * （往目录里丢一个 txt 就能直接生效）。
 *
 * 零 import：不依赖裸包解析，只用 process.getBuiltinModule。
 */

const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

const name = 'dialog-fence';
/**
 * 硬依赖只有 systemPrompt 与 commands：CLI / TUI / headless 三种形态都能装。
 * Web 专属的 HTTP 路由（给可视化面板用）通过 ctx.inject(['connection'], …) 挂载 ——
 * 服务出现才注册，永远不会去「猜」它是否已就绪（0.2.x 用 ctx.get 软取导致 404，
 * 因为 cordis 的 ctx.get 默认 strict=true，只返回已 ACTIVE 的服务）。
 */
const inject = ['systemPrompt', 'commands'];

/** 插件自身目录（规则与文档都放这里，产物集中）。 */
const SELF_DIR = import.meta.dirname;
/**
 * 数据目录可被环境变量覆盖：仅供测试指向临时目录，避免测试直接改写线上规则
 * （测试中途崩溃就会弄丢真实规则）。正常运行时该变量不存在。
 */
const DATA_DIR =
  typeof process.env.DIALOG_FENCE_DIR === 'string' && process.env.DIALOG_FENCE_DIR.length > 0
    ? process.env.DIALOG_FENCE_DIR
    : path.join(SELF_DIR, 'rules');

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

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

const RULE_FILE_PATTERN = /\.txt$/i;

// ---------------------------------------------------------------------------
// 会话 id → 目录名（sessionId 由 host 铸造，这里再保险一次）
// ---------------------------------------------------------------------------

function safeName(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return '';
  if (trimmed === '.' || trimmed === '..') return '';
  // 只允许字母数字与 - _ . ；其余一律替换，杜绝路径穿越。
  return trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
}

function sanitizeSessionId(value) {
  const safe = safeName(value);
  return safe.length === 0 || safe === '.' || safe === '..' ? '' : safe;
}

function sessionDirOf(sessionId) {
  const safe = sanitizeSessionId(sessionId);
  return safe === '' ? '' : path.join(SESSIONS_DIR, safe);
}

// ---------------------------------------------------------------------------
// 开关状态：state.json 只存 global / sessions[].enabled，不存规则正文
// ---------------------------------------------------------------------------

let stateCache = { mtimeMs: -1, size: -1, state: null };

function emptyState() {
  return { version: 2, global: { enabled: true }, sessions: {} };
}

function loadState() {
  let stat;
  try {
    stat = fs.statSync(STATE_FILE);
  } catch {
    stateCache = { mtimeMs: -1, size: -1, state: null };
    return emptyState();
  }
  if (stateCache.state !== null && stateCache.mtimeMs === stat.mtimeMs && stateCache.size === stat.size) return stateCache.state;
  const state = emptyState();
  let parsed = null;
  try {
    // PowerShell 5.1 的 Set-Content / Out-File 默认写 UTF-16LE 或带 BOM 的 UTF-8，
    // 两种情况 JSON.parse 都会抛错，进而把整个会话的围栏静默清空（本项目踩过一次）。
    const buf = fs.readFileSync(STATE_FILE);
    let raw = buf.toString('utf8');
    if (raw.includes('\u0000')) raw = buf.toString('utf16le');
    raw = raw.replace(/^\uFEFF/, '').replace(/^\0+/, '');
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[dialog-fence] state.json 解析失败，本次按默认开关处理: ${error?.message ?? error}`);
    parsed = null;
  }
  if (parsed !== null && typeof parsed === 'object') {
    if (parsed.global !== null && typeof parsed.global === 'object' && parsed.global.enabled === false) state.global.enabled = false;
    const sessions = parsed.sessions;
    if (sessions !== null && typeof sessions === 'object') {
      for (const [id, entry] of Object.entries(sessions)) {
        const safe = sanitizeSessionId(id);
        if (safe === '' || entry === null || typeof entry !== 'object') continue;
        state.sessions[safe] = { enabled: entry.enabled === true };
      }
    }
  }
  stateCache = { mtimeMs: stat.mtimeMs, size: stat.size, state };
  return state;
}

/** 原子写盘：先写 .tmp 再 rename，避免半截 JSON 卡死后续装配。 */
function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, STATE_FILE);
  try {
    const stat = fs.statSync(STATE_FILE);
    stateCache = { mtimeMs: stat.mtimeMs, size: stat.size, state };
  } catch {
    stateCache = { mtimeMs: -1, size: -1, state: null };
  }
}

// ---------------------------------------------------------------------------
// 规则文件：一条规则一个 txt
// ---------------------------------------------------------------------------

/** 目录内的规则文件，按文件名自然排序（前缀数字决定顺序）。 */
function listRuleFiles(sessionId) {
  const dir = sessionDirOf(sessionId);
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
    .map((file) => ({ file, path: path.join(dir, file) }));
}

function readRuleFile(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    let text = buf.toString('utf8');
    if (text.includes('\u0000')) text = buf.toString('utf16le');
    return text.replace(/^\uFEFF/, '').replace(/^\0+/, '').trim();
  } catch {
    return '';
  }
}

/** 读出会话全部规则（跳过空文件）。 */
function readRules(sessionId) {
  const out = [];
  for (const row of listRuleFiles(sessionId)) {
    const text = readRuleFile(row.path);
    if (text.length > 0) out.push({ file: row.file, text });
  }
  return out;
}

function nextPrefix(sessionId) {
  let max = 0;
  for (const row of listRuleFiles(sessionId)) {
    const match = /^(\d+)/.exec(row.file);
    const value = match === null ? 0 : Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return String(max + 1).padStart(2, '0');
}

/** 从规则正文生成可读文件名后缀（中文等非 ASCII 一律退回 rule）。 */
function slugOf(text) {
  const ascii = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return ascii.length > 0 ? ascii : 'rule';
}

function ruleFileName(sessionId, text) {
  return `${nextPrefix(sessionId)}-${slugOf(text)}.txt`;
}

function ensureSessionDir(sessionId) {
  const dir = sessionDirOf(sessionId);
  if (dir === '') throw new Error('非法会话 id');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRuleFile(sessionId, file, text) {
  const dir = ensureSessionDir(sessionId);
  const name2 = typeof file === 'string' && RULE_FILE_PATTERN.test(file) ? path.basename(file) : ruleFileName(sessionId, text);
  const abs = path.join(dir, name2);
  // 统一 UTF-8 无 BOM 落盘，换行统一成 \n，便于任何编辑器直接改。
  fs.writeFileSync(abs, `${String(text).replace(/\r\n?/g, '\n').trim()}\n`, 'utf8');
  return name2;
}

function removeRuleFile(sessionId, file) {
  const dir = sessionDirOf(sessionId);
  if (dir === '') return false;
  const base = path.basename(String(file ?? ''));
  if (!RULE_FILE_PATTERN.test(base)) return false;
  try {
    fs.unlinkSync(path.join(dir, base));
    return true;
  } catch {
    return false;
  }
}

function clearRuleFiles(sessionId) {
  let removed = 0;
  for (const row of listRuleFiles(sessionId)) {
    try {
      fs.unlinkSync(row.path);
      removed += 1;
    } catch {
      /* 忽略单个失败 */
    }
  }
  return removed;
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

/** 会话是否启用：state.json 有显式条目则以它为准，否则「目录里有 txt」即启用。 */
function isSessionEnabled(state, sessionId, rules) {
  if (state.global.enabled !== true) return false;
  const explicit = state.sessions[sessionId];
  if (explicit !== undefined) return explicit.enabled === true;
  return rules.length > 0;
}

function fenceTextFor(sessionId) {
  if (sessionId === '') return '';
  const state = loadState();
  const rules = readRules(sessionId);
  if (!isSessionEnabled(state, sessionId, rules)) return '';
  return renderRuleTexts(rules.map((rule) => rule.text));
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

/** 单个会话的快照（面板用）。 */
function snapshotOf(sessionId) {
  const state = loadState();
  const rules = readRules(sessionId);
  const enabled = isSessionEnabled(state, sessionId, rules);
  const rendered = enabled ? renderRuleTexts(rules.map((rule) => rule.text)) : '';
  return {
    ok: true,
    sessionId,
    enabled,
    globalEnabled: state.global.enabled === true,
    rules,
    rendered,
    chars: rendered.length,
    tokens: tokenEstimate(rendered),
    dir: sessionDirOf(sessionId),
    limits: LIMITS,
  };
}

/** 会话清单（设置页用）。目录里有 txt 的会话与 state.json 里登记过的会话取并集。 */
function knownSessions(state) {
  const ids = new Set(Object.keys(state.sessions));
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    dirs = [];
  }
  for (const dir of dirs) if (sanitizeSessionId(dir) !== '') ids.add(dir);
  const rows = [];
  for (const sessionId of ids) {
    const rules = readRules(sessionId);
    rows.push({
      sessionId,
      enabled: isSessionEnabled(state, sessionId, rules),
      ruleCount: rules.length,
      chars: rules.reduce((sum, rule) => sum + rule.text.length, 0),
    });
  }
  rows.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return rows;
}

/** 设置页快照（插件页那一栏用）。 */
function overviewOf() {
  const state = loadState();
  return {
    ok: true,
    globalEnabled: state.global.enabled === true,
    dataDir: DATA_DIR,
    sessionsDir: SESSIONS_DIR,
    stateFile: STATE_FILE,
    sessions: knownSessions(state),
    limits: LIMITS,
  };
}

function setGlobal(state, enabled) {
  state.global.enabled = enabled === true;
  saveState(state);
}

/** 面板提交的动作；与 /fence 命令共用同一套文件，改完下一轮即生效。 */
function applyAction(sessionId, action, payload) {
  const state = loadState();

  if (action === 'toggleGlobal') {
    setGlobal(state, payload.enabled);
    return overviewOf();
  }
  if (action === 'toggle') {
    const entry = state.sessions[sessionId];
    state.sessions[sessionId] = { enabled: payload.enabled === true };
    saveState(state);
    if (entry === undefined && state.sessions[sessionId].enabled) {
      /* 首次启用只需登记，规则文件按需创建 */
    }
    return snapshotOf(sessionId);
  }
  if (action === 'add') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (text.length === 0) return { ok: false, error: '规则文本不能为空' };
    if (text.length > MAX_RULE_CHARS) return { ok: false, error: `单条规则最多 ${MAX_RULE_CHARS} 字符（当前 ${text.length}）` };
    const existing = readRules(sessionId);
    if (existing.some((rule) => rule.text === text)) return snapshotOf(sessionId);
    if (existing.length >= MAX_RULES) return { ok: false, error: `规则已达上限 ${MAX_RULES} 条` };
    writeRuleFile(sessionId, undefined, text);
    state.sessions[sessionId] = { enabled: true };
    saveState(state);
    return snapshotOf(sessionId);
  }
  if (action === 'update') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const file = typeof payload.file === 'string' ? payload.file : '';
    if (file === '') return { ok: false, error: '缺少规则文件名' };
    if (text.length === 0) return { ok: false, error: '规则文本不能为空' };
    if (text.length > MAX_RULE_CHARS) return { ok: false, error: `单条规则最多 ${MAX_RULE_CHARS} 字符（当前 ${text.length}）` };
    // 只允许改已存在的规则文件：否则一个拼错的文件名会凭空多出一条规则。
    if (!listRuleFiles(sessionId).some((row) => row.file === path.basename(file))) {
      return { ok: false, error: `没有找到规则文件 ${file}` };
    }
    writeRuleFile(sessionId, file, text);
    if (state.sessions[sessionId] === undefined) {
      state.sessions[sessionId] = { enabled: true };
      saveState(state);
    }
    return snapshotOf(sessionId);
  }
  if (action === 'remove') {
    const file = typeof payload.file === 'string' ? payload.file : '';
    if (file === '') return { ok: false, error: '缺少规则文件名' };
    if (!removeRuleFile(sessionId, file)) return { ok: false, error: `没有找到规则文件 ${file}` };
    return snapshotOf(sessionId);
  }
  if (action === 'clear') {
    clearRuleFiles(sessionId);
    return snapshotOf(sessionId);
  }
  if (action === 'reset') {
    clearRuleFiles(sessionId);
    delete state.sessions[sessionId];
    saveState(state);
    return snapshotOf(sessionId);
  }
  return { ok: false, error: `未知动作 ${action}` };
}

async function handleApi(request) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const url = new URL(request.url);
    const rawSession = url.searchParams.get('sessionId');
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
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
  if (action === 'toggleGlobal') {
    const snapshot = applyAction('', action, body ?? {});
    return jsonResponse(snapshot);
  }
  const sessionId = sanitizeSessionId(body?.sessionId);
  if (sessionId === '') return jsonResponse({ ok: false, error: '缺少或非法的 sessionId' }, 400);
  const snapshot = applyAction(sessionId, action, body ?? {});
  return snapshot.ok === false ? jsonResponse(snapshot, 400) : jsonResponse(snapshot);
}

// ---------------------------------------------------------------------------
// 命令：/fence
// ---------------------------------------------------------------------------

function statusText(sessionId) {
  const state = loadState();
  const rules = readRules(sessionId);
  const enabled = isSessionEnabled(state, sessionId, rules);
  const texts = rules.map((rule) => rule.text);
  const text = enabled ? renderRuleTexts(texts) : '';
  const lines = [
    `/fence status — 会话 ${sessionId}`,
    `全局开关: ${state.global.enabled === true ? '开' : '关（所有会话都不注入）'}`,
    `本会话: ${enabled ? '已启用' : '未启用（本会话零注入）'}`,
    `规则: ${rules.length} 条，注入文本 ${text.length} 字符 ≈ ${tokenEstimate(text)} token`,
    `目录: ${sessionDirOf(sessionId)}`,
  ];
  if (rules.length > 0) {
    lines.push('规则清单（文件名 → 正文）:');
    rules.forEach((rule, index) => lines.push(`  ${index + 1}. [${rule.file}] ${rule.text}`));
  }
  if (enabled && text.length > 0) {
    lines.push('实际注入（每次快照变化才重新追加一次）:');
    lines.push('---8<---');
    lines.push(text);
    lines.push('--->8---');
  }
  return lines.join('\n');
}

const HELP = [
  '/fence                      显示状态',
  '/fence on | off             启用 / 停用本会话围栏（立即生效，下一轮就注入）',
  '/fence add <规则文本>       新建一条规则（= 新建一个 txt 文件）',
  '/fence rm <序号>            删除第 N 条规则（= 删除对应 txt 文件）',
  '/fence clear                清空本会话规则文件',
  '/fence reset                清空规则并删除本会话的开关登记',
  '/fence dir                  显示本会话规则目录（可直接用编辑器维护）',
  '',
  '规则只对当前会话生效，其它对话完全不受影响。',
  '每条规则是 rules/sessions/<会话 id>/NN-<名称>.txt，改文件内容即改规则。',
].join('\n');

function succeed(text) {
  return { kind: 'success', text };
}

function fail(text) {
  return { kind: 'error', text };
}

function handleFence(invocation) {
  const sessionId = typeof invocation.agent?.id === 'string' ? invocation.agent.id : '';
  if (sessionId === '') return fail('/fence: 无法确定当前会话 id');
  const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
  const [verbRaw, ...rest] = raw.length === 0 ? [] : raw.split(/\s+/);
  const verb = (verbRaw ?? '').toLowerCase();
  const argument = raw.length === 0 ? '' : raw.slice(verbRaw.length).trim();

  const state = loadState();

  if (verb === '' || verb === 'status' || verb === 'show') return succeed(statusText(sessionId));
  if (verb === 'help' || verb === '?') return succeed(HELP);
  if (verb === 'dir') return succeed(`本会话规则目录:\n${sessionDirOf(sessionId)}\n\n全局状态文件:\n${STATE_FILE}`);

  if (verb === 'on' || verb === 'off') {
    state.sessions[sessionId] = { enabled: verb === 'on' };
    saveState(state);
    return succeed(statusText(sessionId));
  }

  if (verb === 'add') {
    if (argument.length === 0) return fail('/fence add 需要规则文本');
    if (argument.length > MAX_RULE_CHARS) return fail(`单条规则最多 ${MAX_RULE_CHARS} 字符（当前 ${argument.length}）`);
    const existing = readRules(sessionId);
    if (existing.some((rule) => rule.text === argument)) return succeed(`该规则已存在，未重复添加。\n${statusText(sessionId)}`);
    if (existing.length >= MAX_RULES) return fail(`规则已达上限 ${MAX_RULES} 条，请先 /fence rm <序号>`);
    const file = writeRuleFile(sessionId, undefined, argument);
    state.sessions[sessionId] = { enabled: true };
    saveState(state);
    return succeed(`已写入 ${file}\n${statusText(sessionId)}`);
  }

  if (verb === 'rm' || verb === 'remove' || verb === 'del') {
    const index = Number.parseInt(argument, 10);
    const rules = readRules(sessionId);
    if (!Number.isInteger(index) || index < 1 || index > rules.length) {
      return fail(`/fence rm 需要 1..${rules.length} 之间的序号`);
    }
    const target = rules[index - 1];
    removeRuleFile(sessionId, target.file);
    return succeed(`已删除 ${target.file}: ${target.text}\n${statusText(sessionId)}`);
  }

  if (verb === 'clear') {
    const removed = clearRuleFiles(sessionId);
    return succeed(`已删除 ${removed} 个规则文件。\n${statusText(sessionId)}`);
  }

  if (verb === 'reset') {
    const removed = clearRuleFiles(sessionId);
    delete state.sessions[sessionId];
    saveState(state);
    return succeed(`已删除 ${removed} 个规则文件并清除本会话开关登记。\n${statusText(sessionId)}`);
  }

  return fail(`未知子命令 "${verbRaw}"。\n${HELP}`);
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

async function apply(ctx) {
  // 首次运行时把目录建好，用户点开就能看到 sessions 文件夹。
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  } catch {
    /* 目录不可写时后面所有读写都会各自降级，这里不阻塞启动 */
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
        description: '会话级围栏规则：给当前对话设置边界（每条规则一个 txt 文件）',
        input: { hint: '[on|off|add <文本>|rm <序号>|clear|reset|dir|status]' },
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

  console.log(`[dialog-fence] ready: data=${DATA_DIR} context=${CONTEXT_NAME}@${CONTEXT_ORDER}`);
}

export { apply, inject, name };
