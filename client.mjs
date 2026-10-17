window.__ModuleLoader__.load({
  id: '@oheco/dsh-godot-control',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const labels = {
      zh: { title: 'Godot 配对', intro: '每个 Godot 编辑器都可使用下方端口和令牌连接同一个 DSH。', address: '连接地址', port: '端口', token: '连接令牌', show: '显示令牌', hide: '隐藏令牌', copy: '复制令牌', copyAddress: '复制地址', copySession: '复制会话 ID', copied: '已复制', failed: '操作失败', refresh: '刷新状态', connected: '已连接的 Godot 编辑器', offline: '等待 Godot 编辑器连接', waiting: '正在读取连接信息', routing: '列表每 2 秒自动刷新。每次操作都需要让 DSH 使用对应的会话 ID（session_id）选择目标，即使只连接一个编辑器。', session: '会话 ID', readiness: '状态', install: '在每个项目中安装并启用 DSH Godot Control，在 Godot 的 DSH Godot 面板保存配对。' },
      en: { title: 'Godot pairing', intro: 'Each Godot editor can connect to the same DSH using the port and token below.', address: 'Connection address', port: 'Port', token: 'Pairing token', show: 'Reveal token', hide: 'Hide token', copy: 'Copy token', copyAddress: 'Copy address', copySession: 'Copy session ID', copied: 'Copied', failed: 'Operation failed', refresh: 'Refresh status', connected: 'Connected Godot editors', offline: 'Waiting for a Godot editor', waiting: 'Loading connection information', routing: 'The list refreshes every 2 seconds. Every editor operation requires its session ID (session_id), even when only one editor is connected.', session: 'Session ID', readiness: 'Status', install: 'Install and enable DSH Godot Control in each project, then save pairing in Godot\'s DSH Godot dock.' },
    };
    function PairingPanel({ view, t, readStatus, readPairing, subscribeReset }) {
      const [status, setStatus] = React.useState(null), [secret, setSecret] = React.useState(null), [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState(''), [statusError, setStatusError] = React.useState('');
      const mounted = React.useRef(false), pending = React.useRef(null), refreshStatus = React.useRef(async () => {});
      React.useEffect(() => {
        if (view !== 'page') return;
        mounted.current = true;
        let active = null, inFlight = null;
        const refresh = () => {
          if (inFlight) return inFlight;
          const abort = new AbortController(); active = abort;
          inFlight = readStatus(abort.signal).then(value => {
            if (!abort.signal.aborted) { setStatus(value); setStatusError(''); }
          }, error => {
            if (!abort.signal.aborted) { setStatus(null); setStatusError(error.message); }
          }).finally(() => { if (active === abort) { active = null; inFlight = null; } });
          return inFlight;
        };
        refreshStatus.current = refresh;
        refresh();
        const timer = setInterval(refresh, 2000);
        const remove = subscribeReset(() => {
          pending.current?.abort(); active?.abort(); active = null; inFlight = null;
          setSecret(null); setStatus(null); setStatusError(''); setNotice(''); setBusy(false);
          refresh();
        });
        return () => { mounted.current = false; clearInterval(timer); active?.abort(); pending.current?.abort(); refreshStatus.current = async () => {}; remove(); };
      }, [view, readStatus, subscribeReset]);
      if (view !== 'page') return null;
      const run = async operation => {
        const abort = new AbortController(); pending.current?.abort(); pending.current = abort; setBusy(true); setNotice('');
        try { await operation(abort.signal); } catch (error) { if (!abort.signal.aborted && mounted.current) setNotice(`${t('failed')}: ${error.message}`); }
        finally { if (pending.current === abort) { pending.current = null; if (mounted.current) setBusy(false); } }
      };
      const copy = async value => { await navigator.clipboard.writeText(value); if (mounted.current) setNotice(t('copied')); };
      return h('section', { className: 'oheco-godot-pairing', 'aria-label': t('title') },
        h('style', null, '.oheco-godot-pairing{padding:20px;border:1px solid var(--dsw-alias-label-caption);border-radius:12px;display:grid;gap:14px;color:var(--dsw-alias-label-primary)}.oheco-godot-pairing h3,.oheco-godot-pairing p,.oheco-godot-pairing ul{margin:0}.oheco-godot-pairing h3{font-size:14px;font-weight:500}.oheco-godot-pairing p{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}.oheco-godot-pairing label{display:grid;gap:6px;font-size:13px}.oheco-godot-pairing input{box-sizing:border-box;width:100%;min-width:0;background:transparent;color:inherit;border:1px solid var(--dsw-alias-label-caption);border-radius:6px;padding:8px 10px;font:13px/20px ui-monospace,monospace}.oheco-godot-pairing button{background:transparent;color:inherit;border:1px solid var(--dsw-alias-label-caption);border-radius:6px;padding:7px 12px;font:inherit;cursor:pointer}.oheco-godot-pairing button:disabled{opacity:.5;cursor:default}.oheco-godot-pairing button:hover{border-color:var(--dsw-alias-state-business-primary)}.oheco-godot-pairing :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.oheco-godot-pairing li{font-size:13px;line-height:22px}.oheco-godot-pairing code{user-select:text}'),
        h('h3', null, t('title')), h('p', null, t('intro')),
        h('p', { role: 'status', 'data-godot-connection': status?.connected ? 'connected' : 'offline' }, status?.connected ? `${t('connected')}: ${status.sessions.length}` : t(status ? 'offline' : 'waiting')),
        h('label', null, t('address'), h('input', { 'aria-label': t('address'), readOnly: true, value: status?.endpoint || '', style: { width: '100%' } })),
        h('label', null, t('token'), h('input', { 'aria-label': t('token'), type: secret ? 'text' : 'password', readOnly: true, value: secret || '', placeholder: '••••••••••••••••', autoComplete: 'off', spellCheck: false, style: { width: '100%' } })),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', disabled: busy || !status, onClick: () => secret ? setSecret(null) : run(async signal => { const value = await readPairing(signal); if (!signal.aborted && mounted.current) setSecret(value.token); }) }, t(secret ? 'hide' : 'show')),
          h('button', { type: 'button', disabled: busy || !status, onClick: () => run(async signal => { const value = await readPairing(signal); if (!signal.aborted) await copy(value.token); }) }, t('copy')),
          h('button', { type: 'button', disabled: busy || !status, onClick: () => run(() => copy(status.endpoint)) }, t('copyAddress')),
          h('button', { type: 'button', disabled: busy, onClick: () => run(() => refreshStatus.current()) }, t('refresh'))),
        h('p', { role: 'status' }, statusError ? `${t('failed')}: ${statusError}` : notice),
        h('p', null, t('routing')),
        h('ul', { style: { paddingInlineStart: 20 } }, ...(status?.sessions || []).map(session => h('li', { key: session.session_id, 'data-godot-session': session.session_id, style: { marginBlock: 12, overflowWrap: 'anywhere' } },
          h('div', null, session.project_path),
          h('div', null, `PID: ${session.editor_pid} · ${t('readiness')}: ${session.readiness}`),
          h('div', null, `${t('session')}: `, h('code', null, session.session_id)),
          h('button', { type: 'button', disabled: busy, onClick: () => run(() => copy(session.session_id)), 'aria-label': `${t('copySession')}: ${session.session_id}` }, t('copySession'))))),
        h('p', null, t('install')));
    }
    return { inject: ['slots', 'connection', 'locale'], apply(ctx) {
      ctx.locale.register('oheco.godot', labels);
      const request = async (endpoint, signal) => { const response = await fetch(`/api/oheco-godot-control/${endpoint}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const result = await response.json(); if (!result.ok) throw new Error(result.error.message); return result.value; };
      const actions = { readStatus: signal => request('status', signal), readPairing: signal => request('pairing', signal), subscribeReset: listener => ctx.on('connection/reset', listener) };
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: '@oheco/dsh-godot-control', locale: 'oheco.godot', inject: () => actions }, PairingPanel));
    } };
  },
});
