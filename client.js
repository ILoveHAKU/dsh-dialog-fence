/**
 * dialog-fence — 浏览器半边（可视化操作界面）
 *
 * 加载方式：dsh-client-modules 把本文件作为懒 CJS 模块发布到
 * /plugins/dsh-dialog-fence/client.js，由 window.__ModuleLoader__ 执行。
 * 因此这里不能 import 任何模块，只能 require 平台 seed（这里只用到 react）。
 *
 * 与宿主通信：宿主半边在 /api/dialog-fence 注册了同源 JSON 路由
 * （connection.fetch.register，自带鉴权）。浏览器侧用文档相对路径
 * "api/dialog-fence"（与 @deepseek-ai/dsh-session-log-export 的写法一致）。
 *
 * 三处界面：
 *  1. conversation.session.header.utilities —— 会话头部「围栏」按钮
 *  2. shell.overlay —— 该会话的规则浮层（每条规则一行，可单独改/删）
 *  3. settings.plugins.tab —— 插件页里的「对话围栏」一页（全局开关 + 会话清单）
 */
window.__ModuleLoader__.load({
  id: 'dsh-dialog-fence',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');

    const NS = 'dsh-dialog-fence';
    const API_ROUTE = '/api/dialog-fence'.slice(1);
    /** 通用规则层的伪会话 id：API 用 scope=common 区分，客户端复用它做 store 键。 */
    const COMMON_SCOPE = 'common';
    const SLOT_HEADER = 'conversation.session.header.utilities';
    const SLOT_OVERLAY = 'shell.overlay';
    const SLOT_SETTINGS = 'settings.section';
    const SLOT_PLUGINS_TAB = 'settings.plugins.tab';
    // 组合包自己的配置区：以 npm 包名为 key，渲染在「插件 → 已安装 → 本包」详情页的
    // 描述与行之间（owner 只传 view: 'page'）。用它而不是 plugins.item，
    // 因为 plugins.item 的语义固定是「官方分组里的一张卡片」。
    const SLOT_BUNDLE_CONFIG = 'plugins.bundle.config';
    const BUNDLE_NAME = 'dsh-dialog-fence';

    // ---------------------------------------------------------------------
    // 极小的外部 store：面板开合 + 各会话快照 + 全局概览
    // ---------------------------------------------------------------------

    const listeners = new Set();
    const state = {
      openSessionId: null,
      bySession: {},
      /** 通用规则层快照（对每个对话生效）—— 设置页的主视图就是它。 */
      common: null,
      overview: null,
      busy: false,
      error: null,
      /**
       * 「打开文件夹」这类没有可观察副作用的一次性动作的结果。
       * 后端回包里有 opened / openReason / openWarning，以前全被丢掉，
       * 于是成功、失败、被系统拦掉在界面上长得一模一样 —— 用户只会觉得「点了没反应」。
       */
      notice: null,
    };

    function emit() {
      for (const listener of [...listeners]) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function getSnapshot() {
      return state;
    }

    function patch(next) {
      Object.assign(state, next);
      emit();
    }

    function entryOf(sessionId) {
      return state.bySession[String(sessionId)];
    }

    async function request(sessionId, body) {
      const query =
        sessionId === undefined || sessionId === null
          ? ''
          : `?${new URLSearchParams(sessionId === COMMON_SCOPE ? { scope: COMMON_SCOPE } : { sessionId: String(sessionId) }).toString()}`;
      const init =
        body === undefined
          ? { method: 'GET', headers: { accept: 'application/json' } }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({
                ...(sessionId === undefined || sessionId === null
                  ? {}
                  : sessionId === COMMON_SCOPE
                    ? { scope: COMMON_SCOPE }
                    : { sessionId: String(sessionId) }),
                ...body,
              }),
            };
      const response = await fetch(body === undefined ? `${API_ROUTE}${query}` : API_ROUTE, init);
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      if (!response.ok || payload.ok === false) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    }

    /** 拉一次某会话快照。面板打开时调用，动作之后也调用。 */
    async function refresh(sessionId) {
      try {
        const snapshot = await request(sessionId);
        patch({ bySession: { ...state.bySession, [String(sessionId)]: snapshot }, error: null });
      } catch (error) {
        patch({ error: error?.message ?? String(error) });
      }
    }

    /** 拉一次通用规则层快照（设置页主视图）。 */
    async function refreshCommon() {
      try {
        const common = await request(COMMON_SCOPE);
        patch({ common, error: null });
      } catch (error) {
        patch({ error: error?.message ?? String(error) });
      }
    }

    /** 拉一次全局概览（设置页用）。 */
    async function refreshOverview() {
      try {
        const overview = await request(undefined);
        const bySession = { ...state.bySession };
        for (const row of overview.sessions ?? []) {
          if (bySession[String(row.sessionId)] === undefined) {
            bySession[String(row.sessionId)] = { ok: true, sessionId: row.sessionId, enabled: row.enabled, rules: [] };
          }
        }
        patch({ overview, bySession, error: null });
      } catch (error) {
        patch({ error: error?.message ?? String(error) });
      }
    }

    /** 设置页刷新：通用层 + 概览。 */
    async function refreshAll() {
      await Promise.all([refreshCommon(), refreshOverview()]);
    }

    /**
     * 把 openFolder 的回包翻译成一句人话。
     * opened=false 只会在测试模式下发生（宿主设了 DIALOG_FENCE_NO_OPEN=1）；
     * openWarning 是上一次 spawn 的异步失败 —— spawn 的错误是 'error' 事件，
     * 晚于函数返回，所以只能延后一轮报告。
     */
    function noticeOf(snapshot) {
      if (snapshot === null || snapshot === undefined) return null;
      if (snapshot.opened === false) {
        return snapshot.openReason === 'test-mode' ? '测试模式：没有真的打开窗口' : '没有打开窗口';
      }
      if (typeof snapshot.openWarning === 'string' && snapshot.openWarning.length > 0) {
        return `已尝试打开文件夹，但上一次启动资源管理器失败：${snapshot.openWarning}`;
      }
      return '已打开围栏文件夹';
    }

    /** 提交一个动作（toggle / toggleGlobal / add / update / remove / clear / reset / setFile / openFolder）。 */
    async function act(sessionId, action, payload) {
      patch({ busy: true });
      try {
        const snapshot = await request(sessionId, { action, ...(payload ?? {}) });
        if (action === 'openFolder') {
          // 结果必须让用户看见：成功也要有一行提示，否则「没反应」无法与「成功」区分。
          patch({ overview: snapshot, busy: false, error: null, notice: noticeOf(snapshot) });
          await refreshAll();
          return snapshot;
        }
        if (action === 'toggleGlobal' || action === 'setFile') {
          // 这两个动作返回的是概览，且会影响「围栏文件在哪 / 总开关」这类全局信息。
          patch({ overview: snapshot, busy: false, error: null, notice: null });
          await refreshAll();
          return snapshot;
        }
        if (sessionId === COMMON_SCOPE) {
          patch({ common: snapshot, busy: false, error: null });
          await refreshOverview();
        } else {
          patch({ bySession: { ...state.bySession, [String(sessionId)]: snapshot }, busy: false, error: null });
        }
        return snapshot;
      } catch (error) {
        patch({ busy: false, error: error?.message ?? String(error), notice: null });
        return null;
      }
    }

    function useExternalStore() {
      const [, force] = react.useState(0);
      react.useEffect(
        () =>
          subscribe(() => {
            force((value) => value + 1);
          }),
        [],
      );
      return getSnapshot();
    }

    // ---------------------------------------------------------------------
    // 样式：只用主题 token，light / dark 自适应
    // ---------------------------------------------------------------------

    const CSS = [
      '.dialog-fence-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dialog-fence-trigger:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dialog-fence-trigger[data-on="true"]{color:var(--dsw-alias-brand-text);border-color:var(--dsw-alias-brand-primary)}',
      '.dialog-fence-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;',
      'background:var(--dsw-alias-brand-primary);color:#fff;font-size:11px;line-height:16px;text-align:center}',
      '.dialog-fence-panel{position:fixed;right:24px;bottom:96px;width:480px;max-height:72vh;display:flex;',
      'flex-direction:column;z-index:60;pointer-events:auto;border-radius:14px;overflow:hidden;',
      'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);',
      'box-shadow:0 18px 48px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dialog-fence-head{display:flex;align-items:center;gap:8px;padding:12px 14px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dialog-fence-title{font-weight:600;flex:1}',
      '.dialog-fence-body{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:8px}',
      '.dialog-fence-foot{display:flex;gap:8px;align-items:center;padding:10px 14px;',
      'border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dialog-fence-btn{height:26px;padding:0 10px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.dialog-fence-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dialog-fence-btn[data-primary="true"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:#fff}',
      '.dialog-fence-btn[disabled]{opacity:.5;cursor:default}',
      '.dialog-fence-row{display:flex;gap:8px;align-items:center;padding:7px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.dialog-fence-row[data-editing="true"]{background:var(--dsw-alias-bg-layer-3)}',
      '.dialog-fence-index{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:16px}',
      '.dialog-fence-text{flex:1;white-space:pre-wrap;word-break:break-word;line-height:1.5}',
      '.dialog-fence-file{color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,monospace}',
      '.dialog-fence-input{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:7px;box-sizing:border-box;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;',
      'font:inherit;font-size:13px}',
      '.dialog-fence-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.dialog-fence-error{color:var(--dsw-alias-state-danger-primary,#d33);font-size:12px}',
      '.dialog-fence-empty{color:var(--dsw-alias-label-tertiary);padding:6px 2px}',
      '.dialog-fence-dir{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);',
      'word-break:break-all;line-height:1.5}',
      '.dialog-fence-page{display:flex;flex-direction:column;gap:14px;padding:16px;color:var(--dsw-alias-label-primary);',
      'font-size:13px;max-width:760px}',
      '.dialog-fence-flat{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);',
      'font-size:13px}',
      '.dialog-fence-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;',
      'display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.dialog-fence-card-head{display:flex;align-items:center;gap:10px}',
      '.dialog-fence-card-title{font-weight:600;flex:1}',
      '.dialog-fence-h{font-weight:600;font-size:14px}',
      '.dialog-fence-table{display:flex;flex-direction:column;gap:4px}',
      '.dialog-fence-tr{display:flex;gap:10px;align-items:center;padding:6px 8px;border-radius:7px;',
      'background:var(--dsw-alias-bg-layer-2);font-size:12px}',
      '.dialog-fence-tr > .dialog-fence-c1{flex:1;font-family:ui-monospace,monospace;word-break:break-all}',
      '.dialog-fence-pill{padding:1px 7px;border-radius:9px;font-size:11px;',
      'background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
      '.dialog-fence-pill[data-on="true"]{background:var(--dsw-alias-brand-primary);color:#fff}',
    ].join('');

    const TAG_ID = `${NS}/client.css`;
    function ensureCss() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------------
    // 1) Session 头部按钮
    // ---------------------------------------------------------------------

    function HeaderAction(props) {
      const sessionId = props.sessionId;
      const snapshot = useExternalStore();
      const entry = entryOf(sessionId);
      const common = snapshot.common;
      const overview = snapshot.overview;
      const commonCount = common?.rules?.length ?? 0;
      const sessionCount = entry?.rules?.length ?? 0;
      // 徽标必须是「真实注入的条数」：通用层 + 本对话专属层，两层都算。
      // 0.6.0 只算了会话层，所以配了 10 条通用规则时按钮还显示 1，看着像没生效。
      const count = commonCount + sessionCount;
      const globalOn = overview?.globalEnabled !== false && common?.enabled !== false;
      const on = globalOn && (count > 0 || entry?.enabled === true);
      const isOpen = String(snapshot.openSessionId) === String(sessionId);

      react.useEffect(() => {
        // 挂载时拉一次通用层：否则按钮上的数字要等别人打开设置页才准。
        refreshAll();
        if (isOpen) refresh(sessionId);
      }, [isOpen, String(sessionId)]);

      return react.createElement(
        'button',
        {
          type: 'button',
          className: 'dialog-fence-trigger',
          'data-on': on ? 'true' : 'false',
          title: on ? `围栏已启用（通用 ${commonCount} 条 + 本对话 ${sessionCount} 条）` : '围栏未启用',
          onClick: () => patch({ openSessionId: isOpen ? null : String(sessionId) }),
        },
        react.createElement('span', null, '围栏'),
        count > 0 ? react.createElement('span', { className: 'dialog-fence-badge' }, String(count)) : null,
      );
    }

    // ---------------------------------------------------------------------
    // 2) 浮层面板：每条规则一行，单独编辑（不用 textarea）
    // ---------------------------------------------------------------------

    function RuleRow(props) {
      const { rule, index, busy, onSave, onRemove } = props;
      const [editing, setEditing] = react.useState(false);
      const [draft, setDraft] = react.useState(rule.text);

      react.useEffect(() => {
        setDraft(rule.text);
      }, [rule.text]);

      const commit = () => {
        const text = draft.trim();
        if (text.length === 0) return;
        onSave(rule.index, text);
        setEditing(false);
      };

      if (!editing) {
        return react.createElement(
          'div',
          { className: 'dialog-fence-row' },
          react.createElement('span', { className: 'dialog-fence-index' }, String(index + 1)),
          react.createElement('span', { className: 'dialog-fence-text' }, rule.text),
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => setEditing(true) },
            '改',
          ),
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => onRemove(rule.index) },
            '删',
          ),
        );
      }
      return react.createElement(
        'div',
        { className: 'dialog-fence-row', 'data-editing': 'true' },
        react.createElement('span', { className: 'dialog-fence-index' }, String(index + 1)),
        react.createElement('input', {
          className: 'dialog-fence-input',
          value: draft,
          autoFocus: true,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              setDraft(rule.text);
              setEditing(false);
            }
          },
        }),
        react.createElement(
          'button',
          { type: 'button', className: 'dialog-fence-btn', 'data-primary': 'true', onClick: commit },
          '保存',
        ),
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'dialog-fence-btn',
            onClick: () => {
              setDraft(rule.text);
              setEditing(false);
            },
          },
          '取消',
        ),
      );
    }

    function Panel() {
      const snapshot = useExternalStore();
      const sessionId = snapshot.openSessionId;
      const [draft, setDraft] = react.useState('');
      const [draftCommon, setDraftCommon] = react.useState('');

      // 打开面板就把「本会话 + 通用层 + 概览」一起拉齐，
      // 否则设置页里刚改过的通用规则不会出现在这里（0.7.0 修的就是这个不同步）。
      react.useEffect(() => {
        setDraft('');
        setDraftCommon('');
        if (sessionId !== null) {
          refresh(sessionId);
          refreshAll();
        }
      }, [sessionId]);

      if (sessionId === null) return null;
      const entry = entryOf(sessionId);
      const common = snapshot.common;
      const overview = snapshot.overview;
      const rules = entry?.rules ?? [];
      const commonRules = common?.rules ?? [];
      const busy = snapshot.busy === true;
      const globalOn = overview?.globalEnabled !== false && common?.enabled !== false;

      const add = () => {
        const text = draft.trim();
        if (text.length === 0) return;
        act(sessionId, 'add', { text });
        setDraft('');
      };
      const addCommon = () => {
        const text = draftCommon.trim();
        if (text.length === 0) return;
        act(COMMON_SCOPE, 'add', { text });
        setDraftCommon('');
      };

      return react.createElement(
        'div',
        { className: 'dialog-fence-panel' },
        react.createElement(
          'div',
          { className: 'dialog-fence-head' },
          react.createElement('span', { className: 'dialog-fence-title' }, '对话围栏'),
          react.createElement('span', { className: 'dialog-fence-pill', 'data-on': globalOn ? 'true' : 'false' }, globalOn ? '总开关：开' : '总开关：关'),
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'dialog-fence-btn',
              disabled: busy,
              onClick: () => act(sessionId, 'toggle', { enabled: !(entry?.enabled === true) }),
            },
            entry?.enabled === true ? '停用本对话' : '启用本对话',
          ),
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', onClick: () => patch({ openSessionId: null }) },
            '关闭',
          ),
        ),
        react.createElement(
          'div',
          { className: 'dialog-fence-body' },
          // ---- 通用规则：对所有对话生效，这里直接可改（与设置页同一份数据） ----
          react.createElement('div', { className: 'dialog-fence-h' }, '围栏规则（对每个对话生效）'),
          common === null
            ? react.createElement('div', { className: 'dialog-fence-empty' }, '读取中…')
            : commonRules.length === 0
              ? react.createElement('div', { className: 'dialog-fence-empty' }, '还没有规则。在下面输入一条并回车。')
              : commonRules.map((rule, index) =>
                  react.createElement(RuleRow, {
                    key: `common-${index}`,
                    rule,
                    index,
                    busy,
                    onSave: (target, text) => act(COMMON_SCOPE, 'update', { index: target, text }),
                    onRemove: (target) => act(COMMON_SCOPE, 'remove', { index: target }),
                  }),
                ),
          react.createElement('input', {
            className: 'dialog-fence-input',
            placeholder: '新建一条通用规则，回车添加（写进同一个围栏文件）',
            value: draftCommon,
            onChange: (event) => setDraftCommon(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') addCommon();
            },
          }),
          react.createElement(
            'div',
            { className: 'dialog-fence-card-head' },
            react.createElement(
              'button',
              { type: 'button', className: 'dialog-fence-btn', disabled: busy || draftCommon.trim().length === 0, onClick: addCommon },
              '添加到通用规则',
            ),
            react.createElement(
              'span',
              { className: 'dialog-fence-meta', style: { flex: 1 } },
              common === null ? '' : `${commonRules.length}/${common.limits?.maxRules ?? 40} 条 · 单条上限 ${common.limits?.maxRuleChars ?? 2000} 字符`,
            ),
          ),

          // ---- 本对话专属规则 ----
          react.createElement('div', { className: 'dialog-fence-h', style: { marginTop: 6 } }, '仅本对话的额外规则'),
          entry === undefined
            ? react.createElement('div', { className: 'dialog-fence-empty' }, '读取中…')
            : rules.length === 0
              ? react.createElement('div', { className: 'dialog-fence-empty' }, '没有专属规则（只用上面的通用规则）。')
              : rules.map((rule, index) =>
                  react.createElement(RuleRow, {
                    key: `session-${index}`,
                    rule,
                    index,
                    busy,
                    onSave: (target, text) => act(sessionId, 'update', { index: target, text }),
                    onRemove: (target) => act(sessionId, 'remove', { index: target }),
                  }),
                ),
          react.createElement('input', {
            className: 'dialog-fence-input',
            placeholder: '新增一条只作用于本对话的规则，回车添加',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') add();
            },
          }),
          snapshot.error !== null ? react.createElement('div', { className: 'dialog-fence-error' }, snapshot.error) : null,
          snapshot.notice !== null && snapshot.notice !== undefined
            ? react.createElement('div', { className: 'dialog-fence-meta', 'data-notice': 'open-folder' }, snapshot.notice)
            : null,
          entry !== undefined
            ? react.createElement(
                'div',
                null,
                react.createElement(
                  'div',
                  { className: 'dialog-fence-meta' },
                  `注入 ${entry.chars ?? 0} 字符 ≈ ${entry.tokens ?? 0} token · 仅在快照变化时追加一次 · 上限 ${entry.limits?.maxRules ?? 40} 条/层`,
                ),
                react.createElement('div', { className: 'dialog-fence-dir' }, entry.file ?? entry.dir ?? ''),
              )
            : null,
        ),
        react.createElement(
          'div',
          { className: 'dialog-fence-foot' },
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', 'data-primary': 'true', disabled: busy || draft.trim().length === 0, onClick: add },
            '添加专属规则',
          ),
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => act(sessionId, 'clear') },
            '清空专属',
          ),
          react.createElement('button', { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => act(undefined, 'openFolder') }, '打开文件夹'),
          react.createElement('span', { className: 'dialog-fence-meta', style: { flex: 1 } }, '下一轮生效'),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 3) 配置页：插件页（settings.plugins.tab / plugins.bundle.config）与设置左栏（settings.section）
    // ---------------------------------------------------------------------

    function FencePage(props) {
      // bundle 详情页传入的是 {view:'page'}，那里已经有自己的标题与留白，
      // 所以除显式 flat 之外，view === 'page' 也用紧凑版式。
      const flat = (props !== undefined && props !== null && props.flat === true) || (props?.view === 'page');
      const snapshot = useExternalStore();
      const [draft, setDraft] = react.useState('');
      const [draftFile, setDraftFile] = react.useState('');
      const [moving, setMoving] = react.useState(false);
      const common = snapshot.common;
      const overview = snapshot.overview;
      const busy = snapshot.busy === true;

      react.useEffect(() => {
        refreshAll();
      }, []);

      const globalOn = overview?.globalEnabled !== false && common?.enabled !== false;
      const rules = common?.rules ?? [];
      const sessionCount = (overview?.sessions ?? []).length;
      const fenceFile = common?.file ?? overview?.file ?? '';
      const notice = snapshot.notice;

      const add = () => {
        const text = draft.trim();
        if (text.length === 0) return;
        act(COMMON_SCOPE, 'add', { text });
        setDraft('');
      };
      const moveTo = () => {
        const target = draftFile.trim();
        if (target.length === 0) return;
        act(undefined, 'setFile', { file: target }).then((result) => {
          if (result !== null) {
            setMoving(false);
            setDraftFile('');
          }
        });
      };

      return react.createElement(
        'div',
        { className: flat ? 'dialog-fence-flat' : 'dialog-fence-page' },
        // ---- 卡片 1：总开关 ----
        react.createElement(
          'div',
          { className: 'dialog-fence-card' },
          react.createElement(
            'div',
            { className: 'dialog-fence-card-head' },
            react.createElement('span', { className: 'dialog-fence-card-title' }, '对话围栏（dialog-fence）'),
            react.createElement('span', { className: 'dialog-fence-pill', 'data-on': globalOn ? 'true' : 'false' }, globalOn ? '总开关：开' : '总开关：关'),
            react.createElement(
              'button',
              {
                type: 'button',
                className: 'dialog-fence-btn',
                disabled: busy,
                onClick: () => act(undefined, 'toggleGlobal', { enabled: !globalOn }),
              },
              globalOn ? '关闭围栏' : '开启围栏',
            ),
          ),
          react.createElement(
            'div',
            { className: 'dialog-fence-meta' },
            '下面这些规则对每一个对话都生效（包括新开的对话）；改完下一轮即生效。总开关关掉后，所有对话立即零注入。',
          ),
          react.createElement(
            'div',
            { className: 'dialog-fence-card-head' },
            react.createElement('span', { className: 'dialog-fence-dir', style: { flex: 1 } }, fenceFile === '' ? '' : `围栏文件：${fenceFile}`),
            react.createElement('button', { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => act(undefined, 'openFolder') }, '打开文件夹'),
            react.createElement('button', { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => setMoving(!moving) }, moving ? '取消' : '更改位置'),
          ),
          moving
            ? react.createElement(
                'div',
                { className: 'dialog-fence-card-head' },
                react.createElement('input', {
                  className: 'dialog-fence-input',
                  placeholder: '新的围栏文件绝对路径，例如 D:\\我的围栏\\fence.json（填目录会自动补 fence.json）',
                  value: draftFile,
                  onChange: (event) => setDraftFile(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') moveTo();
                  },
                }),
                react.createElement(
                  'button',
                  { type: 'button', className: 'dialog-fence-btn', 'data-primary': 'true', disabled: busy || draftFile.trim().length === 0, onClick: moveTo },
                  '迁移',
                ),
              )
            : null,
          moving
            ? react.createElement('div', { className: 'dialog-fence-meta' }, '迁移会把现有规则一起写到新文件，并在原目录留一个 location.json 指针。之后删掉指针就回到默认位置。')
            : null,
          // 「打开文件夹」没有可观察的副作用，必须自己把结果说出来，否则成功与失败长得一样。
          typeof notice === 'string' && notice.length > 0
            ? react.createElement('div', { className: 'dialog-fence-meta', 'data-notice': 'open-folder' }, notice)
            : null,
        ),

        // ---- 卡片 2：通用规则（主视图，可直接编辑正文） ----
        react.createElement(
          'div',
          { className: 'dialog-fence-card' },
          react.createElement('div', { className: 'dialog-fence-h' }, '围栏规则（对每个对话生效）'),
          common === null
            ? react.createElement('div', { className: 'dialog-fence-empty' }, '读取中…')
            : rules.length === 0
              ? react.createElement('div', { className: 'dialog-fence-empty' }, '还没有规则。在下面输入一条并回车。')
              : rules.map((rule, index) =>
                  react.createElement(RuleRow, {
                    key: `common-${index}`,
                    rule,
                    index,
                    busy,
                    onSave: (target, text) => act(COMMON_SCOPE, 'update', { index: target, text }),
                    onRemove: (target) => act(COMMON_SCOPE, 'remove', { index: target }),
                  }),
                ),
          react.createElement('input', {
            className: 'dialog-fence-input',
            placeholder: '新建一条规则，回车添加（所有规则存在同一个围栏文件里）',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') add();
            },
          }),
          snapshot.error !== null ? react.createElement('div', { className: 'dialog-fence-error' }, snapshot.error) : null,
          react.createElement(
            'div',
            { className: 'dialog-fence-card-head' },
            react.createElement(
              'button',
              { type: 'button', className: 'dialog-fence-btn', 'data-primary': 'true', disabled: busy || draft.trim().length === 0, onClick: add },
              '添加',
            ),
            react.createElement(
              'button',
              {
                type: 'button',
                className: 'dialog-fence-btn',
                disabled: busy || rules.length === 0,
                onClick: () => act(COMMON_SCOPE, 'clear'),
              },
              '清空全部',
            ),
            react.createElement(
              'span',
              { className: 'dialog-fence-meta', style: { flex: 1 } },
              common === null
                ? ''
                : `注入 ${common.chars ?? 0} 字符 ≈ ${common.tokens ?? 0} token · ${rules.length}/${common.limits?.maxRules ?? 40} 条 · 单条上限 ${common.limits?.maxRuleChars ?? 2000} 字符`,
            ),
          ),
        ),

        // ---- 卡片 3：会话专属规则（次要，不再列 sessionId） ----
        react.createElement(
          'div',
          { className: 'dialog-fence-card' },
          react.createElement('div', { className: 'dialog-fence-h' }, '某个对话的额外规则（可选）'),
          react.createElement(
            'div',
            { className: 'dialog-fence-meta' },
            '上面是通用规则，对每个对话都生效。如果只想给某一个对话追加规则，点那个对话右上角的「围栏」按钮，在那里维护——那些规则只会叠加到该对话，不影响其它对话。',
          ),
          react.createElement(
            'div',
            { className: 'dialog-fence-meta' },
            sessionCount === 0 ? '目前没有任何对话设置过专属规则。' : `目前有 ${sessionCount} 个对话设置过专属规则（叠加在通用规则之后）。`,
          ),
        ),

        // ---- 卡片 4：注入路径说明 ----
        react.createElement(
          'div',
          { className: 'dialog-fence-card' },
          react.createElement('div', { className: 'dialog-fence-h' }, '接入真实请求的唯一一段文本'),
          react.createElement(
            'div',
            { className: 'dialog-fence-meta' },
            '围栏注册成运行时上下文的一个段（order 118），落在「Current runtime context」快照里。文本不变时一条消息都不追加；规则变化时只追加一份新快照，历史前缀不被重写，因此不影响 KV 缓存命中。',
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 插件入口（浏览器半边：没有 systemPrompt，只有 slots / locale）
    // ---------------------------------------------------------------------

    const inject = ['slots'];

    function apply(ctx) {
      ensureCss();

      // 用 slots.inject 而不是直接 register：槽位由别的插件声明，
      // inject 会等声明出现再贡献，插件卸载时自动撤销（与官方插件同款写法）。
      ctx.effect(
        () => ctx.slots.inject(SLOT_HEADER, () => ctx.slots.register({ name: SLOT_HEADER, id: 'dialog-fence', order: 5 }, HeaderAction)),
        'dialog-fence: header',
      );

      ctx.effect(
        () => ctx.slots.inject(SLOT_OVERLAY, () => ctx.slots.register({ name: SLOT_OVERLAY, id: 'dialog-fence-panel' }, Panel)),
        'dialog-fence: overlay',
      );

      // (a) 设置左栏一级菜单项：设置 → 对话围栏（与「通知提醒」「bili 设置」同级）。
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT_SETTINGS, () =>
            ctx.slots.register(
              { name: SLOT_SETTINGS, id: 'dialog-fence', order: 50, label: () => '对话围栏' },
              FencePage,
            ),
          ),
        'dialog-fence: settings-section',
      );

      // (b) 设置 → 内置插件里的「对话围栏」标签页。
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT_PLUGINS_TAB, () =>
            ctx.slots.register(
              { name: SLOT_PLUGINS_TAB, id: 'dialog-fence', order: 50, label: () => '对话围栏' },
              FencePage,
            ),
          ),
        'dialog-fence: plugins-tab',
      );

      // (c) 「插件」页 → 已安装 → 本组合包详情页里的配置区。
      //     owner 用 entryKey: 包名 匹配，并只传 view: 'page'。
      //     注意不能用 plugins.item —— 那个 slot 的语义固定是「官方分组」，改不到「已安装」。
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT_BUNDLE_CONFIG, () =>
            ctx.slots.register({ name: SLOT_BUNDLE_CONFIG, key: BUNDLE_NAME }, FencePage),
          ),
        'dialog-fence: bundle-config',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
