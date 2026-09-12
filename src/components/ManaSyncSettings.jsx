import { useEffect, useState } from 'react';
import { checkManaSyncConnection, connectManaSync, disconnectManaSync, getManaSyncConnection } from '../lib/api';
import './ManaSyncConnect.css';

const DEFAULT_URL = 'https://manasync.net';
function appLink(value) {
  try {
    const input = value.trim();
    if (!input || /^[/\\]/.test(input) || /\s|\\/.test(input)) return null;
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/i, '')}`;
  } catch { return null; }
}

export default function ManaSyncSettings() {
  const [connection,setConnection] = useState(null);
  const [baseUrl,setBaseUrl] = useState(DEFAULT_URL);
  const [token,setToken] = useState('');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [editing,setEditing] = useState(false);
  const [otherServer,setOtherServer] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  useEffect(() => {
    let active = true;
    getManaSyncConnection().then(c => {
      if (!active) return;
      setConnection(c); setBaseUrl(c.baseUrl || DEFAULT_URL); setOtherServer(!!c.baseUrl && c.baseUrl !== DEFAULT_URL);
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  },[]);
  async function save(event) {
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try {
      const connected = await connectManaSync({baseUrl,token});setConnection(connected);setBaseUrl(connected.baseUrl);setToken('');setEditing(false);
      setNotice(`Connected as ${connected.username}. Your ownership is available in print review.`);
    }
    catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  async function check() {
    setBusy(true);setError('');setNotice('');
    try { const c = await checkManaSyncConnection();setConnection(c);setNotice(`Connection verified for ${c.username}.`); }
    catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  async function disconnect() {
    setBusy(true);setError('');setNotice('');
    try {setConnection(await disconnectManaSync());setNotice('Disconnected. You can reconnect with a ManaSync token.');} catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  const address = appLink(baseUrl);
  const connected = connection?.connected;
  const displayedError = error || connection?.error;
  return <section className="user-settings-section manasync-connect" aria-labelledby="manasync-connect-title">
    <div className="manasync-connect-heading"><div><h2 id="manasync-connect-title">ManaSync collection in CLC</h2></div>
      <span className={`manasync-connection-status ${connected && !displayedError ? 'is-connected' : ''}`}>{loading ? 'Checking…' : connected ? displayedError ? 'Needs attention' : 'Connected' : 'Not connected'}</span></div>
    <p>Read ownership for your print lists and record the usable proxies you confirm. One original covers as many proxies as you need.</p>
    {connected && <div className="manasync-connected-account"><div><strong>{connection.username}</strong><small>{connection.baseUrl}</small><small>Last checked: {connection.lastSuccess ? new Date(connection.lastSuccess).toLocaleString() : 'Never'}</small></div>
      <div className="manasync-connect-actions"><button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={check}>{busy ? 'Working…' : 'Check connection'}</button>
        <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => {
          if (editing) {setBaseUrl(connection.baseUrl || DEFAULT_URL);setOtherServer(!!connection.baseUrl && connection.baseUrl !== DEFAULT_URL);}
          setEditing(v => !v);setToken('');
        }}>{editing ? 'Cancel changes' : 'Edit connection'}</button><button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={disconnect}>Disconnect</button></div></div>}
    {(!connected || editing) && <form className="manasync-connect-form" onSubmit={save} aria-label="Connect your ManaSync account">
      <ol className="manasync-connect-steps">
        <li><div><strong>Get your ManaSync token</strong><p>In ManaSync, open <b>More → Integration access</b>. Under <b>Personal app tokens</b>, leave the app name as <b>CLC</b> and choose <b>Create token</b>.</p>
          {address ? <a className="btn btn-secondary" href={address} target="_blank" rel="noopener noreferrer">Open ManaSync <span aria-hidden="true">↗</span></a> : <button className="btn btn-secondary" type="button" disabled>Enter a valid server address</button>}
          <small>Keep the two default permissions: read collection and availability; add, move and adjust proxies.</small></div></li>
        <li><div><label htmlFor="manasync-token"><strong>Paste the token here</strong></label><p>Copy the token ManaSync shows once, then return to this page.</p>
          <input id="manasync-token" type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={8192} placeholder="Paste your ManaSync token" value={token} onChange={e => setToken(e.target.value)} required disabled={busy || loading} aria-describedby="manasync-token-help" />
          <small id="manasync-token-help">Your token is stored encrypted for your CLC account.</small></div></li>
      </ol>
      <details className="manasync-other-server" open={otherServer} onToggle={e => setOtherServer(e.currentTarget.open)}><summary>Using another ManaSync server?</summary>
        <label htmlFor="manasync-url">ManaSync app address</label><input id="manasync-url" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} required disabled={busy || loading} />
        <small>The address must work from the CLC server. Use explicit http:// for local HTTP. Inside a container, localhost means that container; on Docker Desktop, host.docker.internal reaches your Mac.</small>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || loading} onClick={() => {setBaseUrl(DEFAULT_URL);setOtherServer(false);}}>Use manasync.net</button>
      </details>
      <div className="manasync-connect-actions"><button className="btn btn-primary" type="submit" disabled={busy || loading || !token.trim()}>{busy ? 'Verifying account…' : connected ? 'Save connection' : 'Connect ManaSync'}</button><small>{address === DEFAULT_URL ? 'Connects to manasync.net' : address || 'Check your server address'}</small></div>
    </form>}
    {displayedError && <p className="manasync-connect-error" role="alert">{displayedError}</p>}
    {notice && <p className="manasync-connect-notice" role="status">{notice}</p>}
    <details className="manasync-connect-details"><summary>Permissions and account changes</summary>
      <ul><li>Read originals, incoming cards, storage locations and reusable proxies.</li><li>Send prepared batches to Pending prints, then record the usable copies you confirm.</li><li>Keep your original cards unchanged. One owned original covers any number of proxies.</li></ul>
      <p>Use a dedicated token with <code>inventory:read</code> and <code>proxies:write</code>. This connection does not give ManaSync access to your CLC decks; deck access is separate.</p>
      <p>Changing accounts keeps earlier confirmations attached to their original account. Unsent confirmations wait for reconciliation.</p>
    </details>
  </section>;
}
