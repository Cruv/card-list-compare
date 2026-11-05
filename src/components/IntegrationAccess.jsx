import { useState, useEffect, useCallback } from 'react';
import { integrationApi } from '../lib/integrationApi';
import './IntegrationAccess.css';

function PermissionLabels({ scopes }) {
  return <span className="integration-token-permissions">Read decks{scopes.includes('decks:propose') && ' · Propose edits'}{scopes.includes('decks:create') && ' · Create decks'}</span>;
}

export default function IntegrationAccess() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('ManaSync');
  const [proposals, setProposals] = useState(false);
  const [creation, setCreation] = useState(false);
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    const data = await integrationApi('/integrations/tokens');
    setTokens(data.tokens); setLoaded(true);
  }, []);
  useEffect(() => { refresh().catch(error => setError(error.message)); }, [refresh]);

  async function create(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const data = await integrationApi('/integrations/tokens', { method: 'POST', body: JSON.stringify({
        name, scopes: ['decks:read', ...(proposals ? ['decks:propose'] : []), ...(creation ? ['decks:create'] : [])],
      }) });
      setToken(data.token); setCreating(false);
      await refresh();
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function revoke(id) {
    setBusy(true); setError(''); setNotice('');
    try { await integrationApi(`/integrations/tokens/${id}`, { method: 'DELETE' }); await refresh(); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function copyToken() {
    try { await navigator.clipboard.writeText(token); setNotice('Token copied. Paste it into ManaSync.'); }
    catch { setError('Could not copy automatically. Select and copy the token below.'); }
  }
  const active = tokens.filter(item => !item.revokedAt);
  const revoked = tokens.filter(item => item.revokedAt);
  const showCreate = creating || (loaded && active.length === 0 && !token);
  return <section className="integration-access" aria-label="CLC deck access tokens">
    <p>Create a token here and paste it into <strong>ManaSync → More → Connected apps → CLC</strong>. This is separate from reading your ManaSync collection.</p>
    {error && <p role="alert" className="integration-access-error">{error}</p>}
    {!loaded && <p>{error ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => {setError('');refresh().catch(error => setError(error.message));}}>Retry loading tokens</button> : 'Loading deck access…'}</p>}
    {active.length > 0 && <div className="integration-active-tokens"><h3>Active deck tokens</h3><ul className="integration-token-list">{active.map(item => <li key={item.id}>
      <div><strong>{item.name}</strong><PermissionLabels scopes={item.scopes} /></div>
      <button type="button" className="btn btn-secondary btn-sm" aria-label={`Revoke ${item.name} token`} onClick={() => revoke(item.id)} disabled={busy}>Revoke</button>
    </li>)}</ul></div>}
    {token && <div className="integration-token-result" role="region" aria-label="New CLC deck token">
      <strong>Copy your new token now</strong><p>It is shown only once. Paste it into ManaSync’s CLC connection.</p>
      <input aria-label="New integration token" readOnly value={token} onFocus={event => event.target.select()} />
      <button type="button" className="btn btn-secondary btn-sm" onClick={copyToken}>Copy token</button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => {setToken(null);setNotice('');}}>Hide token</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {loaded && !showCreate && !token && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => {setCreating(true);setError('');}}>Create another deck token</button>}
    {showCreate && <form className="user-settings-form integration-token-create" onSubmit={create} aria-label="Create CLC deck token">
      <h3>Create a deck token</h3>
      <label htmlFor="integration-token-name">Token label</label><input id="integration-token-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={busy} />
      <p className="integration-read-permission">Every token can read your digital and paper deck snapshots.</p>
      <label className="integration-access-check"><input type="checkbox" checked={proposals} onChange={event => setProposals(event.target.checked)} disabled={busy} /> Allow proposed edits — reviewed in CLC</label>
      <label className="integration-access-check"><input type="checkbox" checked={creation} onChange={event => setCreation(event.target.checked)} disabled={busy} /> Allow new decks — created immediately</label>
      <div className="integration-token-actions"><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Creating token…' : 'Create CLC deck token'}</button>{active.length > 0 && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setCreating(false)}>Cancel</button>}</div>
    </form>}
    {revoked.length > 0 && <details className="integration-access-help"><summary>Revoked tokens ({revoked.length})</summary><ul className="integration-token-list">{revoked.map(item => <li key={item.id}><div><strong>{item.name}</strong><PermissionLabels scopes={item.scopes} /></div><span>Revoked</span></li>)}</ul></details>}
    <details className="integration-access-help"><summary>About deck permissions</summary><p>Proposals wait for review in CLC. New-deck creation lets ManaSync create a manual deck when you choose “Put it in CLC.” Existing tokens keep their original permissions. Revoke a token to stop its future access.</p></details>
  </section>;
}
