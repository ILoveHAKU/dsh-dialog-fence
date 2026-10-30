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
    // 会话选择：名称来自客户端的 sessions store（槽位的 useSessions），
    // 绝不把 sessionId 显示给用户。
    // ---------------------------------------------------------------------

    /**
     * 一个对话在界面上的名字。
     * displayTitleOf() 在「没有标题、也没有 cwd」时会退化成 sessionId，
     * 所以这里必须显式挡掉「值等于 id」的情况 —— 用户明确要求不要看到 sessionId。
     */
    function sessionLabelOf(row, index) {
      const id = String(row?.id ?? '');
      for (const candidate of [row?.title, row?.displayTitle]) {
        const text = typeof candidate === 'string' ? candidate.trim() : '';
        if (text.length > 0 && text !== id) return text;
      }
      return `未命名对话 ${index + 1}`;
    }

    /**
     * 「当前对话」的判据：retainedBy.mainView > 0。
     * 与 @deepseek-ai/dsh-client-ui-workspace 里 mainSessionId() 的判法一致
     * （那边也是 find(session => (session.retainedBy.mainView ?? 0) > 0)）。
     */
    function currentSessionIdOf(list) {
      const byId = list?.byId ?? {};
      for (const id of Object.keys(byId)) {
        const retained = byId[id]?.retainedBy;
        const count = typeof retained?.mainView === 'number' ? retained.mainView : 0;
        if (count > 0) return String(id);
      }
      return null;
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
      '.dialog-fence-btn{height:26px;padding:0 10px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.dialog-fence-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dialog-fence-btn[data-primary="true"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:#fff}',
      '.dialog-fence-btn[disabled]{opacity:.5;cursor:default}',
      '.dialog-fence-row{display:flex;gap:8px;align-items:center;padding:7px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.dialog-fence-row[data-editing="true"]{background:var(--dsw-alias-bg-layer-3)}',
      '.dialog-fence-index{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:16px}',
      // 单条规则开关：做成滑块（track + knob），点一下立即切换，不需要进编辑态。
      // 停用的规则正文降低对比度，让人一眼看出「这条暂时不生效」。
      '.dialog-fence-switch{flex:none;position:relative;width:30px;height:16px;padding:0;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);cursor:pointer;',
      'transition:background .12s ease,border-color .12s ease}',
      '.dialog-fence-switch::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;',
      'border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .12s ease,background .12s ease}',
      '.dialog-fence-switch[data-on="true"]{background:var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-brand-primary)}',
      '.dialog-fence-switch[data-on="true"]::after{transform:translateX(14px);background:#fff}',
      '.dialog-fence-switch[disabled]{opacity:.5;cursor:default}',
      '.dialog-fence-row[data-on="false"] > .dialog-fence-text{opacity:.45}',
      '.dialog-fence-text{flex:1;white-space:pre-wrap;word-break:break-word;line-height:1.5}',
      '.dialog-fence-file{color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,monospace}',
      '.dialog-fence-input{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:7px;box-sizing:border-box;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;',
      'font:inherit;font-size:13px}',
      // 规则正文用多行输入框：单行 input 改长规则时看不到全貌，也不好换行。
      '.dialog-fence-textarea{flex:1;min-width:0;min-height:66px;padding:6px 8px;border-radius:7px;',
      'box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;',
      'line-height:1.5;resize:vertical;white-space:pre-wrap;word-break:break-word}',
      '.dialog-fence-row[data-editing="true"]{align-items:flex-start}',
      '.dialog-fence-editor{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dialog-fence-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dialog-fence-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.dialog-fence-error{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px}',
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
      // 对话下拉：选项文本是对话名称（不是 sessionId），这里只保证它跟主题一致。
      // 用户 CR-19：原先 `min-width:200px;max-width:320px` 让它在 476px 宽的浮层里
      // 吃掉大半个卡片，同行的按钮与计数被挤到只剩一个字宽、中文逐字换行。
      // 改为 flex:1 + min-width:0（可收缩），并把它单独放进一行。
      '.dialog-fence-select{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:7px;',
      'box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px}',
      // 选择器区：两行（第一行「对话 + 下拉」，第二行「停用/启用 + 计数」）。
      '.dialog-fence-picker{display:flex;flex-direction:column;gap:8px}',
      '.dialog-fence-picker-row{display:flex;align-items:center;gap:10px;min-width:0}',
      '.dialog-fence-picker-row > .dialog-fence-btn{flex:none;white-space:nowrap}',
      // 计数与「对话」标签都是短文本，任何情况下都不许折行。
      '.dialog-fence-count{flex:none;white-space:nowrap;color:var(--dsw-alias-label-tertiary);',
      'font-size:12px;line-height:1.5}',
      '.dialog-fence-label{flex:none;white-space:nowrap;color:var(--dsw-alias-label-tertiary);',
      'font-size:12px;line-height:1.5}',
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
    // 2) 浮层面板：每条规则一行，查看态是纯文本，点「改」才出多行编辑框
    //    （0.9.0 起编辑器用 textarea：规则是成句成段的中文，单行 input 看不全也换不了行）
    // ---------------------------------------------------------------------

    function RuleRow(props) {
      const { rule, index, busy, onSave, onRemove, onToggle } = props;
      const [editing, setEditing] = react.useState(false);
      const [draft, setDraft] = react.useState(rule.text);
      // 老快照里没有 enabled 字段时按启用处理，避免「一升级全变灰」。
      const on = rule.enabled !== false;

      react.useEffect(() => {
        setDraft(rule.text);
      }, [rule.text]);

      const commit = () => {
        const text = draft.trim();
        if (text.length === 0) return;
        onSave(rule.index, text);
        setEditing(false);
      };

      // 单条启停滑块：点一下立刻生效（不等编辑态），停用只是「暂时不进注入」，规则正文保留。
      const switchNode = react.createElement('button', {
        type: 'button',
        className: 'dialog-fence-switch',
        'data-on': on ? 'true' : 'false',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': on ? '停用这条规则' : '启用这条规则',
        title: on ? '当前启用，点击暂时停用' : '当前停用，点击启用',
        disabled: busy,
        onClick: () => onToggle(rule.index, !on),
      });

      if (!editing) {
        return react.createElement(
          'div',
          { className: 'dialog-fence-row', 'data-on': on ? 'true' : 'false' },
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
          // 滑块固定在最右端（CR-18）：放序号后面挤在正文左侧，一列规则读下来视线被打断。
          switchNode,
        );
      }
      return react.createElement(
        'div',
        { className: 'dialog-fence-row', 'data-editing': 'true', 'data-on': on ? 'true' : 'false' },
        react.createElement('span', { className: 'dialog-fence-index' }, String(index + 1)),
        react.createElement(
          'div',
          { className: 'dialog-fence-editor' },
          react.createElement('textarea', {
            className: 'dialog-fence-textarea',
            value: draft,
            rows: 3,
            autoFocus: true,
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              // textarea 里 Enter 必须是换行；保存走 Ctrl/Cmd+Enter，取消走 Escape。
              if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
                event.preventDefault();
                commit();
              }
              if (event.key === 'Escape') {
                setDraft(rule.text);
                setEditing(false);
              }
            },
          }),
          react.createElement('div', { className: 'dialog-fence-hint' }, 'Ctrl+Enter 保存 · Esc 取消 · 可换行'),
        ),
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
        switchNode,
      );
    }

    function Panel(props) {
      const snapshot = useExternalStore();
      const sessionId = snapshot.openSessionId;

      // 打开面板就把「本会话 + 通用层 + 概览」一起拉齐，
      // 否则设置页里刚改过的通用规则不会出现在这里（0.7.0 修的就是这个不同步）。
      react.useEffect(() => {
        if (sessionId !== null) {
          refresh(sessionId);
          refreshAll();
        }
      }, [sessionId]);

      // 点面板外面就关掉。
      // 两个必须排除的落点：
      //  1) 面板内部（含规则编辑框、下拉框），否则一改内容就把自己关了；
      //  2) 会话头部的「围栏」按钮 —— 它自己的 onClick 会 toggle，
      //     如果这里先关，接着 onClick 又把 isOpen 当 false 重新打开，面板就再也关不掉。
      react.useEffect(() => {
        if (sessionId === null) return undefined;
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onPointerDown = (event) => {
          const target = event?.target;
          // 文本节点或非元素目标（合成事件、测试桩）一律不处理。
          if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') return;
          if (target.closest('.dialog-fence-panel') !== null) return;
          if (target.closest('.dialog-fence-trigger') !== null) return;
          patch({ openSessionId: null });
        };
        // 捕获阶段：宿主浮层常在上层截走冒泡，捕获能保证先拿到。
        document.addEventListener('mousedown', onPointerDown, true);
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true);
        };
      }, [sessionId]);

      if (sessionId === null) return null;

      // 浮层与设置页共用同一套卡片（FencePage 的 flat 版式），
      // 这样两处的分区、文案、按钮、对话选择器完全一致 ——
      // 过去浮层是独立实现，缺对话选择器也缺卡片，两边看一眼就知道不是一家人。
      // 浮层额外保留：标题栏 + 总开关状态 + 「关闭」（浮层必须能自己关掉）。
      const common = snapshot.common;
      const overview = snapshot.overview;
      const busy = snapshot.busy === true;
      const globalOn = overview?.globalEnabled !== false && common?.enabled !== false;

      return react.createElement(
        'div',
        { className: 'dialog-fence-panel' },
        react.createElement(
          'div',
          { className: 'dialog-fence-head' },
          react.createElement('span', { className: 'dialog-fence-title' }, '对话围栏'),
          react.createElement(
            'span',
            { className: 'dialog-fence-pill', 'data-on': globalOn ? 'true' : 'false' },
            globalOn ? '总开关：开' : '总开关：关',
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
          react.createElement(FencePage, {
            flat: true,
            // 浮层点开的是「这一条对话」，预览也必须落在它身上。
            preferredSessionId: sessionId,
            useSessions: props === undefined || props === null ? undefined : props.useSessions,
          }),
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
      const [draftSession, setDraftSession] = react.useState('');
      /** 用户在下拉里挑的对话；空字符串表示「跟着默认走」。 */
      const [picked, setPicked] = react.useState('');
      const common = snapshot.common;
      const overview = snapshot.overview;
      const busy = snapshot.busy === true;

      // 槽位把 sessions store 作为 standardProp 传进来（useSessions）；
      // 它同时提供「对话名称」与「当前对话」两个信息，所以设置页不必再问宿主。
      // 三个注册点（settings.section / settings.plugins.tab / plugins.bundle.config）
      // 都带这个 standardProp；万一某个 owner 没给，就退化成「不显示选择器」。
      // 选择器必须返回 store 里的**原对象**：useSessions 底层是 useSyncExternalStore，
      // 每次返回新建的 {} 会让快照身份一直变，轻则告警重则无限重渲染。
      const useSessions = props?.useSessions;
      const sessionById =
        typeof useSessions === 'function' ? useSessions((sessionState) => sessionState?.byId ?? null) : undefined;

      react.useEffect(() => {
        refreshAll();
      }, []);

      const globalOn = overview?.globalEnabled !== false && common?.enabled !== false;
      const rules = common?.rules ?? [];
      const sessionCount = (overview?.sessions ?? []).length;
      const fenceFile = common?.file ?? overview?.file ?? '';
      const notice = snapshot.notice;

      // 下拉里的候选：正在运行的对话（有名字）+ 围栏文件里已经有规则的对话（可能已归档）。
      // 两类行要挡掉：
      //  1) 子代理不是用户眼里的「对话」；
      //  2) blank === true 的空对话 —— 「建了但一句话没说过」。
      //     宿主给这种行的 displayTitle 是 cwd 的 basename（dsh-api-session-controller
      //     的 displayTitleOf：没有 title 就退回 workspaceTitleOf(cwd)），于是下拉里会
      //     冒出一堆 `harness` / `workspace`。官方侧边栏对 blank 行是整行藏掉的，照做。
      const liveRows = [];
      if (sessionById !== undefined && sessionById !== null) {
        for (const id of Object.keys(sessionById)) {
          const row = sessionById[id];
          if (row?.origin === 'subagent') continue;
          if (row?.blank === true) continue;
          liveRows.push({ id: String(row?.id ?? id), label: sessionLabelOf(row, liveRows.length) });
        }
      }
      const liveIds = new Set(liveRows.map((row) => row.id));
      const archivedRows = [];
      for (const row of overview?.sessions ?? []) {
        const id = String(row.sessionId);
        if (liveIds.has(id)) continue;
        archivedRows.push({ id, label: `已归档对话 ${archivedRows.length + 1}` });
      }
      // 浮层（shell.overlay）打开时会把「点开它的那条对话」传进来：那一层必须能编辑
      // 自己所在的对话，哪怕 sessions store 还没就绪。所以这里把它补成一个候选。
      const preferred = typeof props?.preferredSessionId === 'string' ? props.preferredSessionId : '';
      if (preferred !== '' && !liveIds.has(preferred) && !archivedRows.some((row) => row.id === preferred)) {
        liveRows.push({ id: preferred, label: '当前对话' });
        liveIds.add(preferred);
      }
      const choices = [...liveRows, ...archivedRows];

      // 默认选谁：①用户手选的 ②浮层传进来的那条对话 ③当前对话
      // ④围栏里最后一个设置过规则的 ⑤第一个候选
      const currentId = currentSessionIdOf(sessionById === undefined ? null : { byId: sessionById });
      const fallbackId =
        preferred !== '' && liveIds.has(preferred)
          ? preferred
          : currentId !== null && liveIds.has(currentId)
            ? currentId
            : archivedRows.length > 0
              ? archivedRows[archivedRows.length - 1].id
              : liveRows.length > 0
                ? liveRows[0].id
                : '';
      const targetSession = picked !== '' && (liveIds.has(picked) || archivedRows.some((r) => r.id === picked)) ? picked : fallbackId;
      // <option> 的 value 用下标而不是 sessionId：sessionId 没有必要出现在 DOM 里，
      // 而设置页有一条「不得出现会话 id」的界面约束（render 测试在守）。
      const targetIndex = choices.findIndex((choice) => choice.id === targetSession);

      // 选中哪个对话就拉哪个对话的专属规则；换选中项时上一份快照先留着，避免闪空。
      react.useEffect(() => {
        if (targetSession !== '') refresh(targetSession);
      }, [targetSession]);

      const targetEntry = targetSession === '' ? undefined : entryOf(targetSession);
      const targetRules = targetEntry?.rules ?? [];

      const add = () => {
        const text = draft.trim();
        if (text.length === 0) return;
        act(COMMON_SCOPE, 'add', { text });
        setDraft('');
      };
      const addSession = () => {
        const text = draftSession.trim();
        if (text.length === 0 || targetSession === '') return;
        act(targetSession, 'add', { text });
        setDraftSession('');
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
                    onToggle: (target, enabled) => act(COMMON_SCOPE, 'toggleRule', { index: target, enabled }),
                  }),
                ),
          react.createElement('textarea', {
            className: 'dialog-fence-textarea',
            rows: 3,
            spellCheck: false,
            placeholder: '新建一条规则（所有规则存在同一个围栏文件里）。Ctrl+Enter 添加，可换行。',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
                event.preventDefault();
                add();
              }
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

        // ---- 卡片 3：单个对话的专属规则（与右上角浮层同一份数据、同一套操作） ----
        react.createElement(
          'div',
          { className: 'dialog-fence-card' },
          react.createElement('div', { className: 'dialog-fence-h' }, '某个对话的额外规则（可选）'),
          react.createElement(
            'div',
            { className: 'dialog-fence-meta' },
            '上面是通用规则，对每个对话都生效。下面这一层只叠加到所选对话，不影响其它对话；右上角「围栏」浮层改的是同一份数据。',
          ),
          // 对话选择器：只显示名称，绝不显示 sessionId。
          // 名字来自槽位的 useSessions（客户端 sessions store），没有名字时用「未命名对话 N」。
          choices.length === 0
            ? react.createElement(
                'div',
                { className: 'dialog-fence-empty' },
                overview === null && sessionById === undefined ? '读取中…' : '还没有可选的对话。',
              )
            : react.createElement(
                'div',
                { className: 'dialog-fence-picker' },
                // 第一行：标签 + 下拉。下拉 flex:1，宽度跟着卡片走，不再固定 320px。
                react.createElement(
                  'div',
                  { className: 'dialog-fence-picker-row' },
                  react.createElement('span', { className: 'dialog-fence-label' }, '对话'),
                  react.createElement(
                    'select',
                    {
                      className: 'dialog-fence-select',
                      value: String(targetIndex < 0 ? '' : targetIndex),
                      disabled: busy,
                      onChange: (event) => {
                        const next = choices[Number(event.target.value)];
                        setPicked(next === undefined ? '' : next.id);
                      },
                    },
                    choices.map((choice, choiceIndex) =>
                      react.createElement(
                        'option',
                        { key: choice.id, value: String(choiceIndex) },
                        choice.id === currentId ? `${choice.label}（当前）` : choice.label,
                      ),
                    ),
                  ),
                ),
                // 第二行：只对这一个对话开关围栏（不影响别的对话）——浮层过去叫
                // 「停用本对话」，设置页也必须有同一个动作，否则两边行为不一致。
                // 计数放在这一行，且 nowrap —— 两者都不会再被下拉挤到换行。
                react.createElement(
                  'div',
                  { className: 'dialog-fence-picker-row' },
                  targetSession === ''
                    ? null
                    : react.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dialog-fence-btn',
                          disabled: busy,
                          onClick: () => act(targetSession, 'toggle', { enabled: !(targetEntry?.enabled === true) }),
                        },
                        targetEntry?.enabled === true ? '停用该对话' : '启用该对话',
                      ),
                  react.createElement(
                    'span',
                    { className: 'dialog-fence-count' },
                    targetSession === '' ? '' : `${targetRules.length}/${targetEntry?.limits?.maxRules ?? 40} 条专属规则`,
                  ),
                ),
              ),
          targetSession === ''
            ? null
            : targetEntry === undefined || targetEntry.limits === undefined
              ? react.createElement('div', { className: 'dialog-fence-empty' }, '读取中…')
              : targetRules.length === 0
                ? react.createElement('div', { className: 'dialog-fence-empty' }, '这个对话没有专属规则（只用上面的通用规则）。')
                : targetRules.map((rule, index) =>
                    react.createElement(RuleRow, {
                      key: `page-session-${index}`,
                      rule,
                      index,
                      busy,
                      onSave: (target, text) => act(targetSession, 'update', { index: target, text }),
                      onRemove: (target) => act(targetSession, 'remove', { index: target }),
                      onToggle: (target, enabled) => act(targetSession, 'toggleRule', { index: target, enabled }),
                    }),
                  ),
          targetSession === ''
            ? null
            : react.createElement('textarea', {
                className: 'dialog-fence-textarea',
                rows: 2,
                spellCheck: false,
                placeholder: '新增一条只作用于所选对话的规则。Ctrl+Enter 添加，可换行。',
                value: draftSession,
                onChange: (event) => setDraftSession(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
                    event.preventDefault();
                    addSession();
                  }
                },
              }),
          targetSession === ''
            ? null
            : react.createElement(
                'div',
                { className: 'dialog-fence-card-head' },
                react.createElement(
                  'button',
                  { type: 'button', className: 'dialog-fence-btn', 'data-primary': 'true', disabled: busy || draftSession.trim().length === 0, onClick: addSession },
                  '添加专属规则',
                ),
                react.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dialog-fence-btn',
                    disabled: busy || targetRules.length === 0,
                    onClick: () => act(targetSession, 'clear'),
                  },
                  '清空该对话的专属规则',
                ),
                react.createElement(
                  'span',
                  { className: 'dialog-fence-meta', style: { flex: 1 } },
                  targetEntry === undefined || targetEntry.limits === undefined
                    ? ''
                    : `注入 ${targetEntry.chars ?? 0} 字符 ≈ ${targetEntry.tokens ?? 0} token（仅在叠加通用规则之后）`,
                ),
              ),
          sessionCount === 0
            ? null
            : react.createElement(
                'div',
                { className: 'dialog-fence-meta' },
                `目前有 ${sessionCount} 个对话设置过专属规则（叠加在通用规则之后）。`,
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
