window.__ModuleLoader__.load({
  id: '@oheco/dsh-godot-control',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const labels = {
      zh: { title: 'Godot 配对', intro: '启用项目中的 DSH Godot Control 插件，在 Godot 的 DSH Godot 面板填写端口和令牌。', address: '连接地址', port: '端口', token: '连接令牌', show: '显示令牌', hide: '隐藏令牌', copy: '复制令牌', copyAddress: '复制地址', copied: '已复制', failed: '操作失败', refresh: '刷新状态', connected: 'Godot 已连接', offline: '等待 Godot 编辑器连接', waiting: '正在读取连接信息', install: '将安装包中的 godot/addons/dsh_godot 复制到项目的 addons 目录，在项目设置 → 插件中启用 DSH Godot Control。配对只需保存一次，不需要 Python 或 MCP。' },
      en: { title: 'Godot pairing', intro: 'Enable DSH Godot Control in your project, then enter the port and token in Godot\'s DSH Godot dock.', address: 'Connection address', port: 'Port', token: 'Pairing token', show: 'Reveal token', hide: 'Hide token', copy: 'Copy token', copyAddress: 'Copy address', copied: 'Copied', failed: 'Operation failed', refresh: 'Refresh status', connected: 'Godot connected', offline: 'Waiting for a Godot editor', waiting: 'Loading connection information', install: 'Copy godot/addons/dsh_godot from this package into your project\'s addons directory. Enable DSH Godot Control in Project Settings → Plugins. Save pairing once. Python and MCP are not required.' },
    };
    function PairingPanel({ view, t, readStatus, readPairing, subscribeReset }) {
      const [status, setStatus] = React.useState(null), [secret, setSecret] = React.useState(null), [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState('');
      const mounted = React.useRef(false), pending = React.useRef(null);
      React.useEffect(() => {
        mounted.current = true; const abort = new AbortController();
        readStatus(abort.signal).then(value => { if (!abort.signal.aborted) setStatus(value); }, error => { if (!abort.signal.aborted) setNotice(`${t('failed')}: ${error.message}`); });
        const remove = subscribeReset(() => { pending.current?.abort(); abort.abort(); setSecret(null); setStatus(null); setBusy(false); });
        return () => { mounted.current = false; abort.abort(); pending.current?.abort(); remove(); };
      }, [readStatus, subscribeReset]);
      if (view !== 'page') return null;
      const run = async operation => {
        const abort = new AbortController(); pending.current?.abort(); pending.current = abort; setBusy(true); setNotice('');
        try { await operation(abort.signal); } catch (error) { if (!abort.signal.aborted && mounted.current) setNotice(`${t('failed')}: ${error.message}`); }
        finally { if (pending.current === abort) { pending.current = null; if (mounted.current) setBusy(false); } }
      };
      const copy = async value => { await navigator.clipboard.writeText(value); if (mounted.current) setNotice(t('copied')); };
      return h('section', { 'aria-label': t('title'), style: { padding: 20, border: '1px solid var(--dsw-alias-label-caption)', borderRadius: 12, display: 'grid', gap: 14 } },
        h('h3', null, t('title')), h('p', null, t('intro')),
        h('p', { role: 'status', 'data-godot-connection': status?.connected ? 'connected' : 'offline' }, t(status ? status.connected ? 'connected' : 'offline' : 'waiting')),
        h('label', null, t('address'), h('input', { 'aria-label': t('address'), readOnly: true, value: status?.endpoint || '', style: { width: '100%' } })),
        h('label', null, t('token'), h('input', { 'aria-label': t('token'), type: secret ? 'text' : 'password', readOnly: true, value: secret || '', placeholder: '••••••••••••••••', autoComplete: 'off', spellCheck: false, style: { width: '100%' } })),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { disabled: busy || !status, onClick: () => secret ? setSecret(null) : run(async signal => { const value = await readPairing(signal); if (!signal.aborted && mounted.current) setSecret(value.token); }) }, t(secret ? 'hide' : 'show')),
          h('button', { disabled: busy || !status, onClick: () => run(async signal => { const value = await readPairing(signal); if (!signal.aborted) await copy(value.token); }) }, t('copy')),
          h('button', { disabled: busy || !status, onClick: () => run(() => copy(status.endpoint)) }, t('copyAddress')),
          h('button', { disabled: busy, onClick: () => run(async signal => { const value = await readStatus(signal); if (!signal.aborted && mounted.current) setStatus(value); }) }, t('refresh'))),
        h('p', { role: 'status' }, notice),
        h('ul', null, ...(status?.sessions || []).map(session => h('li', { key: session.session_id }, `${session.project_path} · ${session.readiness}`))),
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
