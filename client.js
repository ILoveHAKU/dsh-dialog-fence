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

    // ---------------------------------------------------------------------
    // 极小的外部 store：面板的开合状态 + 当前会话的规则快照
    // ---------------------------------------------------------------------

    const listeners = new Set();
    const state = {
      openSessionId: null,
      bySession: {},
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
      const init =
        body === undefined
          ? { method: 'GET', headers: { accept: 'application/json' } }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ sessionId: String(sessionId), ...body }),
            };
      const url =
        body === undefined
          ? `${API_ROUTE}?${new URLSearchParams({ sessionId: String(sessionId) }).toString()}`
          : API_ROUTE;
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      if (!response.ok || payload.ok === false) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    }

    /** 拉一次快照。面板打开时调用，动作之后也调用。 */
    async function refresh(sessionId) {
      try {
        const snapshot = await request(sessionId);
        patch({
          bySession: { ...state.bySession, [String(sessionId)]: snapshot },
          error: null,
        });
      } catch (error) {
        patch({ error: error?.message ?? String(error) });
      }
    }

    /** 提交一个动作（toggle / add / update / remove / clear / reset）。 */
    async function act(sessionId, action, payload) {
      patch({ busy: true });
      try {
        const snapshot = await request(sessionId, { action, ...(payload ?? {}) });
        patch({
          bySession: { ...state.bySession, [String(sessionId)]: snapshot },
          busy: false,
          error: null,
        });
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
      '.dialog-fence-panel{position:fixed;right:24px;bottom:96px;width:440px;max-height:70vh;display:flex;',
      'flex-direction:column;z-index:60;pointer-events:auto;border-radius:14px;overflow:hidden;',
      'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);',
      'box-shadow:0 18px 48px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dialog-fence-head{display:flex;align-items:center;gap:8px;padding:12px 14px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dialog-fence-title{font-weight:600;flex:1}',
      '.dialog-fence-body{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
      '.dialog-fence-foot{display:flex;gap:8px;align-items:center;padding:10px 14px;',
      'border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dialog-fence-btn{height:26px;padding:0 10px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.dialog-fence-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dialog-fence-btn[data-primary="true"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:#fff}',
      '.dialog-fence-btn[disabled]{opacity:.5;cursor:default}',
      '.dialog-fence-row{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.dialog-fence-index{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:16px}',
      '.dialog-fence-text{flex:1;white-space:pre-wrap;word-break:break-word;line-height:1.5}',
      '.dialog-fence-area{width:100%;min-height:64px;resize:vertical;padding:8px 10px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;',
      'font:inherit;font-size:13px;box-sizing:border-box}',
      '.dialog-fence-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.dialog-fence-error{color:var(--dsw-alias-state-danger-primary,#d33);font-size:12px}',
      '.dialog-fence-empty{color:var(--dsw-alias-label-tertiary);padding:8px 2px}',
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
    // Session 头部按钮
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
    // 浮层面板（shell.overlay，root 作用域）
    // ---------------------------------------------------------------------

    function Panel() {
      const snapshot = useExternalStore();
      const sessionId = snapshot.openSessionId;
      const [draft, setDraft] = react.useState('');
      const [editing, setEditing] = react.useState(null);

      react.useEffect(() => {
        setDraft('');
        setEditing(null);
      }, [sessionId]);

      if (sessionId === null) return null;
      const entry = entryOf(sessionId);
      const rules = entry?.rules ?? [];
      const busy = snapshot.busy === true;

      const submit = () => {
        const text = draft.trim();
        if (text.length === 0) return;
        if (editing !== null) act(sessionId, 'update', { index: editing, text });
        else act(sessionId, 'add', { text });
        setDraft('');
        setEditing(null);
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
              onClick: () => act(sessionId, 'toggle', { enabled: !(entry?.enabled === true) }),
              disabled: busy,
            },
            entry?.enabled === true ? '停用' : '启用',
          ),
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'dialog-fence-btn',
              onClick: () => patch({ openSessionId: null }),
            },
            '关闭',
          ),
        ),
        react.createElement(
          'div',
          { className: 'dialog-fence-body' },
          entry === undefined
            ? react.createElement('div', { className: 'dialog-fence-empty' }, '读取中…')
            : rules.length === 0
              ? react.createElement('div', { className: 'dialog-fence-empty' }, '还没有规则。在下面输入一条，回车或点「添加」。')
              : rules.map((rule, index) =>
                  react.createElement(
                    'div',
                    { className: 'dialog-fence-row', key: index },
                    react.createElement('span', { className: 'dialog-fence-index' }, String(index + 1)),
                    react.createElement('span', { className: 'dialog-fence-text' }, rule),
                    react.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dialog-fence-btn',
                        onClick: () => {
                          setEditing(index + 1);
                          setDraft(rule);
                        },
                      },
                      '改',
                    ),
                    react.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dialog-fence-btn',
                        onClick: () => act(sessionId, 'remove', { index: index + 1 }),
                      },
                      '删',
                    ),
                  ),
                ),
          react.createElement('textarea', {
            className: 'dialog-fence-area',
            placeholder: '例如：不要修改本仓库以外的文件\n例如：结论不确定时必须标注出来',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
          }),
          react.createElement(
            'div',
            { className: 'dialog-fence-foot' },
            react.createElement(
              'button',
              { type: 'button', className: 'dialog-fence-btn', 'data-primary': 'true', onClick: submit, disabled: busy },
              editing !== null ? `保存第 ${editing} 条` : '添加',
            ),
            editing !== null
              ? react.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dialog-fence-btn',
                    onClick: () => {
                      setEditing(null);
                      setDraft('');
                    },
                  },
                  '取消',
                )
              : null,
            react.createElement(
              'button',
              { type: 'button', className: 'dialog-fence-btn', onClick: () => act(sessionId, 'clear') },
              '清空',
            ),
            react.createElement('span', { className: 'dialog-fence-meta', style: { flex: 1 } }, '下一轮生效'),
          ),
          snapshot.error !== null ? react.createElement('div', { className: 'dialog-fence-error' }, snapshot.error) : null,
          entry !== undefined
            ? react.createElement(
                'div',
                { className: 'dialog-fence-meta' },
                `注入 ${entry.chars ?? 0} 字符 ≈ ${entry.tokens ?? 0} token · 仅在快照变化时追加一次 · 上限 ${entry.limits?.maxRules ?? 40} 条`,
              )
            : null,
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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
