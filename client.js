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
    const SLOT_HEADER = 'conversation.session.header.utilities';
    const SLOT_OVERLAY = 'shell.overlay';
    const SLOT_PLUGINS_TAB = 'settings.plugins.tab';

    // ---------------------------------------------------------------------
    // 极小的外部 store：面板开合 + 各会话快照 + 全局概览
    // ---------------------------------------------------------------------

    const listeners = new Set();
    const state = {
      openSessionId: null,
      bySession: {},
      overview: null,
      busy: false,
      error: null,
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
      const query = sessionId === undefined || sessionId === null ? '' : `?${new URLSearchParams({ sessionId: String(sessionId) }).toString()}`;
      const init =
        body === undefined
          ? { method: 'GET', headers: { accept: 'application/json' } }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ ...(sessionId === undefined || sessionId === null ? {} : { sessionId: String(sessionId) }), ...body }),
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

    /** 拉一次全局概览（插件页用）。 */
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

    /** 提交一个动作（toggle / toggleGlobal / add / update / remove / clear / reset）。 */
    async function act(sessionId, action, payload) {
      patch({ busy: true });
      try {
        const snapshot = await request(sessionId, { action, ...(payload ?? {}) });
        if (action === 'toggleGlobal') {
          patch({ overview: snapshot, busy: false, error: null });
          await refreshOverview();
        } else {
          patch({ bySession: { ...state.bySession, [String(sessionId)]: snapshot }, busy: false, error: null });
        }
      } catch (error) {
        patch({ busy: false, error: error?.message ?? String(error) });
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
      const count = entry?.rules?.length ?? 0;
      const on = entry?.enabled === true;
      const isOpen = String(snapshot.openSessionId) === String(sessionId);

      react.useEffect(() => {
        if (isOpen) refresh(sessionId);
      }, [isOpen, String(sessionId)]);

      return react.createElement(
        'button',
        {
          type: 'button',
          className: 'dialog-fence-trigger',
          'data-on': on ? 'true' : 'false',
          title: on ? `围栏已启用（${count} 条规则）` : '围栏未启用',
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
        onSave(rule.file, text);
        setEditing(false);
      };

      if (!editing) {
        return react.createElement(
          'div',
          { className: 'dialog-fence-row' },
          react.createElement('span', { className: 'dialog-fence-index' }, String(index + 1)),
          react.createElement(
            'span',
            { className: 'dialog-fence-text' },
            rule.text,
            react.createElement('div', { className: 'dialog-fence-file' }, rule.file),
          ),
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => setEditing(true) },
            '改',
          ),
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => onRemove(rule.file) },
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

      react.useEffect(() => {
        setDraft('');
      }, [sessionId]);

      if (sessionId === null) return null;
      const entry = entryOf(sessionId);
      const rules = entry?.rules ?? [];
      const busy = snapshot.busy === true;

      const add = () => {
        const text = draft.trim();
        if (text.length === 0) return;
        act(sessionId, 'add', { text });
        setDraft('');
      };

      return react.createElement(
        'div',
        { className: 'dialog-fence-panel' },
        react.createElement(
          'div',
          { className: 'dialog-fence-head' },
          react.createElement('span', { className: 'dialog-fence-title' }, '对话围栏'),
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'dialog-fence-btn',
              disabled: busy,
              onClick: () => act(sessionId, 'toggle', { enabled: !(entry?.enabled === true) }),
            },
            entry?.enabled === true ? '停用' : '启用',
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
          entry === undefined
            ? react.createElement('div', { className: 'dialog-fence-empty' }, '读取中…')
            : rules.length === 0
              ? react.createElement('div', { className: 'dialog-fence-empty' }, '还没有规则。在下面输入一条并回车。')
              : rules.map((rule, index) =>
                  react.createElement(RuleRow, {
                    key: rule.file,
                    rule,
                    index,
                    busy,
                    onSave: (file, text) => act(sessionId, 'update', { file, text }),
                    onRemove: (file) => act(sessionId, 'remove', { file }),
                  }),
                ),
          react.createElement('input', {
            className: 'dialog-fence-input',
            placeholder: '新建一条规则，回车添加（每条规则单独存成一个 txt 文件）',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') add();
            },
          }),
          snapshot.error !== null ? react.createElement('div', { className: 'dialog-fence-error' }, snapshot.error) : null,
          entry !== undefined
            ? react.createElement(
                'div',
                null,
                react.createElement(
                  'div',
                  { className: 'dialog-fence-meta' },
                  `注入 ${entry.chars ?? 0} 字符 ≈ ${entry.tokens ?? 0} token · 仅在快照变化时追加一次 · 上限 ${entry.limits?.maxRules ?? 40} 条`,
                ),
                react.createElement('div', { className: 'dialog-fence-dir' }, entry.dir ?? ''),
              )
            : null,
        ),
        react.createElement(
          'div',
          { className: 'dialog-fence-foot' },
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', 'data-primary': 'true', disabled: busy || draft.trim().length === 0, onClick: add },
            '添加',
          ),
          react.createElement(
            'button',
            { type: 'button', className: 'dialog-fence-btn', disabled: busy, onClick: () => act(sessionId, 'clear') },
            '清空',
          ),
          react.createElement('span', { className: 'dialog-fence-meta', style: { flex: 1 } }, '下一轮生效'),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 3) 插件页（settings.plugins.tab）：全局开关 + 会话清单
    // ---------------------------------------------------------------------

    function PluginsTab() {
      const snapshot = useExternalStore();
      const overview = snapshot.overview;
      const busy = snapshot.busy === true;

      react.useEffect(() => {
        refreshOverview();
      }, []);

      const globalOn = overview?.globalEnabled !== false;
      const sessions = overview?.sessions ?? [];

      return react.createElement(
        'div',
        { className: 'dialog-fence-page' },
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
            '围栏按会话隔离：只有在「对话」里启用、并且至少有一条规则的会话才会被注入。总开关关掉后，所有会话立即零注入。',
          ),
          overview?.dataDir !== undefined
            ? react.createElement('div', { className: 'dialog-fence-dir' }, `数据目录：${overview.dataDir}`)
            : null,
        ),
        react.createElement(
          'div',
          { className: 'dialog-fence-card' },
          react.createElement('div', { className: 'dialog-fence-h' }, '会话'),
          sessions.length === 0
            ? react.createElement('div', { className: 'dialog-fence-empty' }, '还没有任何会话配置过围栏。')
            : react.createElement(
                'div',
                { className: 'dialog-fence-table' },
                sessions.map((row) =>
                  react.createElement(
                    'div',
                    { className: 'dialog-fence-tr', key: row.sessionId },
                    react.createElement('span', { className: 'dialog-fence-c1' }, row.sessionId),
                    react.createElement('span', { className: 'dialog-fence-pill', 'data-on': row.enabled ? 'true' : 'false' }, row.enabled ? '启用' : '停用'),
                    react.createElement('span', null, `${row.ruleCount} 条`),
                  ),
                ),
              ),
          react.createElement(
            'div',
            { className: 'dialog-fence-meta' },
            '每条规则是 sessions/<会话 id>/NN-<名称>.txt 一个文件，可以直接用任意编辑器增删改，保存后下一轮生效。',
          ),
          snapshot.error !== null ? react.createElement('div', { className: 'dialog-fence-error' }, snapshot.error) : null,
        ),
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

      // 插件页（设置 → 内置插件）：dsh web 与 DSH Desktop 都有这一区。
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT_PLUGINS_TAB, () =>
            ctx.slots.register(
              { name: SLOT_PLUGINS_TAB, id: 'dialog-fence', order: 50, label: () => '对话围栏' },
              PluginsTab,
            ),
          ),
        'dialog-fence: plugins-tab',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
