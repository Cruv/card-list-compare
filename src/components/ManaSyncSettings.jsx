import { useEffect, useState } from 'react';
import { connectManaSync, disconnectManaSync, getManaSyncConnection } from '../lib/api';
import './ManaSync.css';

export default function ManaSyncSettings() {
  const [connection,setConnection] = useState(null);
  const [baseUrl,setBaseUrl] = useState('');
  const [token,setToken] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  useEffect(() => { getManaSyncConnection().then(c => {setConnection(c);setBaseUrl(c.baseUrl || '');}).catch(e => setError(e.message)); },[]);
  async function save(event) {
    event.preventDefault();setBusy(true);setError('');
    try { const connected = await connectManaSync({baseUrl,token});setConnection(connected);setBaseUrl(connected.baseUrl);setToken(''); }
    catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  async function disconnect() {
    setBusy(true);setError('');
    try {setConnection(await disconnectManaSync());} catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  return <section className="user-settings-section mana-sync">
    <h3>ManaSync collection connection</h3>
    <p>Connect your ManaSync account to view original ownership, incoming purchases, physical locations, and reusable proxies. Prepared print batches appear in that account&rsquo;s Proxy binder under Pending prints. Confirm usable copies in either app after printing.</p>
    <p>Create a dedicated token in ManaSync with <code>inventory:read</code> and <code>proxies:write</code>. The token is encrypted on the CLC server.</p>
    {connection?.configured && <p><strong>{connection.connected ? 'Connected' : 'Disconnected'}: {connection.username}</strong> · account {connection.accountId}<br />Last successful contact: {connection.lastSuccess ? new Date(connection.lastSuccess).toLocaleString() : 'Never'}</p>}
    {connection?.error && <p role="status">{connection.error}</p>}
    <form className="user-settings-form" onSubmit={save}>
      <label htmlFor="manasync-url">ManaSync backend URL</label>
      <input id="manasync-url" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://mana.example.com or http://192.168.1.20:4000" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} required disabled={busy} />
      <small>Use your ManaSync backend address, including a custom domain, port, or reverse-proxy base path. It must be reachable from the CLC server. A bare domain uses HTTPS; include http:// for a local HTTP server. CLC appends the API route to this address.</small>
      <label htmlFor="manasync-token">User-granted ManaSync token</label>
      <input id="manasync-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required disabled={busy} />
      <div className="mana-sync-actions"><button className="btn btn-primary btn-sm" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect account'}</button>
        {connection?.connected && <button className="btn btn-secondary btn-sm" type="button" onClick={disconnect} disabled={busy}>Disconnect</button>}</div>
    </form>
    {error && <p role="alert">{error}</p>}
    <p>Unreported confirmations keep their original account and token. Changing the connection pauses those reports for reconciliation. Downloading or queueing artwork never changes ManaSync inventory.</p>
  </section>;
}
