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
 * 零 import：不依赖裸包解析，只用 process.getBuiltinModule。
 */

const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

const name = 'dialog-fence';
/**
 * 硬依赖只有 systemPrompt 与 commands：CLI / TUI / headless 三种形态都能装。
 * Web 专属的 HTTP 路由（给可视化面板用）通过 ctx.get('connection') 软取，
 * 取不到就静默跳过 —— 这样同一份插件在 `dsh web` 与 `dsh desktop` 下都能跑。
 */
const inject = ['systemPrompt', 'commands'];

/** 插件自身目录（rules.json 与文档都放这里，产物集中）。 */
const SELF_DIR = import.meta.dirname;
/**
 * 规则文件可被环境变量覆盖：仅供冒烟测试指向临时目录，避免测试直接改写线上
 * rules.json（测试中途崩溃就会弄丢真实规则）。正常运行时该变量不存在。
 */
const RULES_FILE =
  typeof process.env.DIALOG_FENCE_RULES === 'string' && process.env.DIALOG_FENCE_RULES.length > 0
    ? process.env.DIALOG_FENCE_RULES
    : path.join(SELF_DIR, 'rules.json');

const CONTEXT_NAME = 'dialog-fence:rules';
/**
 * 运行时上下文的段序：内建只有 SANDBOX_POLICY=110 / APPROVAL_POLICY=115 /
 * SUBAGENT_DELEGATION=120。围栏是「策略层」，插在审批策略之后、委派之前。
 */
const CONTEXT_ORDER = 118;

/** 硬上限，防止规则膨胀把上下文吃掉。 */
const MAX_RULES = 40;
const MAX_TOTAL_CHARS = 2400;

const HEADER = 'Dialog fence (user-set rules binding this conversation; a newer direct user instruction wins on conflict):';

// ---------------------------------------------------------------------------
// 状态存储：单一 rules.json，按 sessionId 分桶；默认什么都没有 = 全关。
// ---------------------------------------------------------------------------

let cache = { mtimeMs: -1, size: -1, state: null };

function emptyState() {
  return { version: 1, sessions: {} };
}

function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return { enabled: false, rules: [] };
  const rules = Array.isArray(raw.rules)
    ? raw.rules.filter((r) => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim())
    : [];
  return { enabled: raw.enabled === true, rules };
}

function loadState() {
  let stat;
  try {
    stat = fs.statSync(RULES_FILE);
  } catch {
    cache = { mtimeMs: -1, size: -1, state: emptyState() };
    return cache.state;
  }
  if (cache.state !== null && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.state;
  let parsed = null;
  try {
    // PowerShell 5.1 的 Set-Content / Out-File 默认写 UTF-16LE 或带 BOM 的 UTF-8，
    // 两种情况 JSON.parse 都会抛错，进而把整个会话的围栏静默清空（本项目踩过一次）。
    // 这里对两种编码都做兼容，宁可多写几行也不让围栏无声消失。
    const buf = fs.readFileSync(RULES_FILE);
    let raw = buf.toString('utf8');
    if (raw.includes('\u0000')) raw = buf.toString('utf16le');
    raw = raw.replace(/^\uFEFF/, '').replace(/^\0+/, '');
    parsed = JSON.parse(raw);
  } catch (error) {
    // 解析失败只可能在文件被外部写坏时发生。围栏不能因此崩掉整轮装配，
    // 但也绝不能无声消失 —— 每次文件版本变化告警一次（缓存按 mtime+size 去重）。
    console.warn(`[dialog-fence] rules.json 解析失败，本会话围栏暂按空处理: ${error?.message ?? error}`);
    parsed = null;
  }
  const state = emptyState();
  if (parsed !== null && typeof parsed === 'object' && parsed.sessions !== null && typeof parsed.sessions === 'object') {
    for (const [id, entry] of Object.entries(parsed.sessions)) {
      if (typeof id === 'string' && id.length > 0) state.sessions[id] = normalizeEntry(entry);
    }
  }
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, state };
  return state;
}

/** 原子写盘：先写 .tmp 再 rename，避免半截 JSON 卡死后续装配。 */
function saveState(state) {
  const dir = path.dirname(RULES_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${RULES_FILE}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, RULES_FILE);
  try {
    const stat = fs.statSync(RULES_FILE);
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, state };
  } catch {
    cache = { mtimeMs: -1, size: -1, state: null };
  }
}

function entryOf(state, sessionId) {
  const existing = state.sessions[sessionId];
  if (existing !== undefined) return existing;
  const created = { enabled: false, rules: [] };
  state.sessions[sessionId] = created;
  return created;
}

// ---------------------------------------------------------------------------
// 渲染：把规则拼成交给模型的文本。空 = 什么都不注入。
// ---------------------------------------------------------------------------

function renderRules(rules) {
  if (rules.length === 0) return '';
  const lines = [HEADER];
  let used = HEADER.length;
  let shown = 0;
  for (const rule of rules) {
    if (shown >= MAX_RULES) break;
    const line = `${shown + 1}. ${rule}`;
    if (used + line.length + 1 > MAX_TOTAL_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown === 0) return '';
  if (shown < rules.length) lines.push(`(fence truncated: ${shown}/${rules.length} rules shown)`);
  return lines.join('\n');
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

function fenceTextFor(sessionId) {
  if (sessionId === '') return '';
  const state = loadState();
  const entry = state.sessions[sessionId];
  if (entry === undefined || entry.enabled !== true) return '';
  return renderRules(entry.rules);
}

// ---------------------------------------------------------------------------
// 可视化面板：宿主侧 HTTP 路由（仅 Web / Desktop 形态提供）
// 走 ctx.connection.fetch.register：自带同源鉴权与 token 校验，比裸 webServer 安全。
// CLI / TUI / headless 没有 connection 服务，这里会整段跳过，不影响 /fence 命令。
// ---------------------------------------------------------------------------

const API_PATH = '/api/dialog-fence';

function jsonResponse(payload, status = 200) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 面板要展示的会话快照。 */
function snapshotOf(sessionId) {
  const state = loadState();
  const entry = state.sessions[sessionId];
  const enabled = entry !== undefined && entry.enabled === true;
  const rules = entry?.rules ?? [];
  const rendered = enabled ? renderRules(rules) : '';
  return {
    ok: true,
    sessionId,
    enabled,
    rules,
    rendered,
    chars: rendered.length,
    tokens: tokenEstimate(rendered),
    limits: { maxRules: MAX_RULES, maxTotalChars: MAX_TOTAL_CHARS, maxRuleChars: 400 },
  };
}

/** 面板提交的动作；与 /fence 命令共用同一套状态，改完下一轮即生效。 */
function applyAction(sessionId, action, payload) {
  const state = loadState();
  if (action === 'toggle') {
    const entry = entryOf(state, sessionId);
    entry.enabled = payload.enabled === true;
    saveState(state);
    return snapshotOf(sessionId);
  }
  if (action === 'add') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (text.length === 0) return { ok: false, error: '规则文本不能为空' };
    if (text.length > 400) return { ok: false, error: `单条规则最多 400 字符（当前 ${text.length}）` };
    const entry = entryOf(state, sessionId);
    if (entry.rules.includes(text)) return snapshotOf(sessionId);
    if (entry.rules.length >= MAX_RULES) return { ok: false, error: `规则已达上限 ${MAX_RULES} 条` };
    entry.rules.push(text);
    entry.enabled = true;
    saveState(state);
    return snapshotOf(sessionId);
  }
  if (action === 'update') {
    const index = Number.parseInt(payload.index, 10);
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const entry = entryOf(state, sessionId);
    if (!Number.isInteger(index) || index < 1 || index > entry.rules.length) return { ok: false, error: '序号越界' };
    if (text.length === 0) return { ok: false, error: '规则文本不能为空' };
    if (text.length > 400) return { ok: false, error: `单条规则最多 400 字符（当前 ${text.length}）` };
    entry.rules[index - 1] = text;
    saveState(state);
    return snapshotOf(sessionId);
  }
  if (action === 'remove') {
    const index = Number.parseInt(payload.index, 10);
    const entry = entryOf(state, sessionId);
    if (!Number.isInteger(index) || index < 1 || index > entry.rules.length) return { ok: false, error: '序号越界' };
    entry.rules.splice(index - 1, 1);
    saveState(state);
    return snapshotOf(sessionId);
  }
  if (action === 'clear') {
    const entry = entryOf(state, sessionId);
    entry.rules = [];
    saveState(state);
    return snapshotOf(sessionId);
  }
  if (action === 'reset') {
    delete state.sessions[sessionId];
    saveState(state);
    return snapshotOf(sessionId);
  }
  return { ok: false, error: `未知动作 ${action}` };
}

function sanitizeSessionId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  // sessionId 由 host 铸造（形如 session-<uuid>）；只接受不含空白/控制字符的短串，
  // 避免面板被诱导去读写别的文件条目。
  if (trimmed.length === 0 || trimmed.length > 200) return '';
  if (/[\s\u0000-\u001f]/.test(trimmed)) return '';
  return trimmed;
}

async function handleApi(request) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const url = new URL(request.url);
    const sessionId = sanitizeSessionId(url.searchParams.get('sessionId'));
    if (sessionId === '') return jsonResponse({ ok: false, error: '缺少或非法的 sessionId' }, 400);
    const snapshot = snapshotOf(sessionId);
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
    return jsonResponse(snapshot);
  }
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method not allowed' }, 405);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return jsonResponse({ ok: false, error: '请求体必须是 JSON' }, 400);
  }
  const sessionId = sanitizeSessionId(body?.sessionId);
  if (sessionId === '') return jsonResponse({ ok: false, error: '缺少或非法的 sessionId' }, 400);
  const action = typeof body?.action === 'string' ? body.action : '';
  const snapshot = applyAction(sessionId, action, body ?? {});
  return snapshot.ok === false ? jsonResponse(snapshot, 400) : jsonResponse(snapshot);
}

// ---------------------------------------------------------------------------
// 命令：/fence
// ---------------------------------------------------------------------------

function tokenEstimate(text) {
  return Math.ceil(text.length / 4);
}

function statusText(sessionId) {
  const state = loadState();
  const entry = state.sessions[sessionId];
  const enabled = entry !== undefined && entry.enabled === true;
  const rules = entry?.rules ?? [];
  const text = enabled ? renderRules(rules) : '';
  const lines = [
    `/fence status — 会话 ${sessionId}`,
    `状态: ${enabled ? '已启用' : '未启用（本会话零注入）'}`,
    `规则: ${rules.length} 条，注入文本 ${text.length} 字符 ≈ ${tokenEstimate(text)} token`,
  ];
  if (rules.length > 0) {
    lines.push('规则清单:');
    rules.forEach((rule, index) => lines.push(`  ${index + 1}. ${rule}`));
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
  '/fence add <规则文本>       追加一条规则',
  '/fence rm <序号>            删除第 N 条规则',
  '/fence clear                清空本会话规则',
  '/fence reset                删除本会话的全部记录',
  '',
  '规则只对当前会话生效，其它对话完全不受影响。',
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

  if (verb === 'on' || verb === 'off') {
    const entry = entryOf(state, sessionId);
    entry.enabled = verb === 'on';
    saveState(state);
    return succeed(statusText(sessionId));
  }

  if (verb === 'add') {
    if (argument.length === 0) return fail('/fence add 需要规则文本');
    if (argument.length > 400) return fail(`单条规则最多 400 字符（当前 ${argument.length}）`);
    const entry = entryOf(state, sessionId);
    if (entry.rules.includes(argument)) return succeed(`该规则已存在，未重复添加。\n${statusText(sessionId)}`);
    if (entry.rules.length >= MAX_RULES) return fail(`规则已达上限 ${MAX_RULES} 条，请先 /fence rm <序号>`);
    entry.rules.push(argument);
    entry.enabled = true;
    saveState(state);
    return succeed(statusText(sessionId));
  }

  if (verb === 'rm' || verb === 'remove' || verb === 'del') {
    const index = Number.parseInt(argument, 10);
    const entry = entryOf(state, sessionId);
    if (!Number.isInteger(index) || index < 1 || index > entry.rules.length) {
      return fail(`/fence rm 需要 1..${entry.rules.length} 之间的序号`);
    }
    const [removed] = entry.rules.splice(index - 1, 1);
    saveState(state);
    return succeed(`已删除第 ${index} 条: ${removed}\n${statusText(sessionId)}`);
  }

  if (verb === 'clear') {
    const entry = entryOf(state, sessionId);
    entry.rules = [];
    saveState(state);
    return succeed(statusText(sessionId));
  }

  if (verb === 'reset') {
    delete state.sessions[sessionId];
    saveState(state);
    return succeed(`已删除本会话围栏记录。\n${statusText(sessionId)}`);
  }

  return fail(`未知子命令 "${verbRaw}"。\n${HELP}`);
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

async function apply(ctx) {
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
        description: '会话级围栏规则：给当前对话设置边界（on/off/add/rm/clear/reset）',
        input: { hint: '[on|off|add <文本>|rm <序号>|clear|reset|status]' },
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

  // Web / Desktop 形态：注册面板用的 JSON 路由。CLI/TUI/headless 没有 connection
  // 服务，整段跳过（这是「同一份插件支持 dsh 与 dsh desktop」的关键）。
  // ctx.get 是「软取值」入口，不写进 inject 就不会成为硬依赖。
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  if (connection !== undefined && typeof connection?.fetch?.register === 'function') {
    ctx.effect(
      () =>
        connection.fetch.register({
          path: API_PATH,
          methods: ['GET', 'HEAD', 'POST'],
          requestBody: 'buffered',
          fetch: handleApi,
        }),
      'dialog-fence.route()',
    );
  }

  console.log(`[dialog-fence] ready: rules=${RULES_FILE} context=${CONTEXT_NAME}@${CONTEXT_ORDER}`);
}

export { apply, inject, name };
