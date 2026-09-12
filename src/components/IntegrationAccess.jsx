import { useState, useEffect, useCallback } from 'react';
import { integrationApi } from '../lib/integrationApi';
import './IntegrationAccess.css';

export default function IntegrationAccess() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('ManaSync');
  const [proposals, setProposals] = useState(false);
  const [creation, setCreation] = useState(false);
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const data = await integrationApi('/integrations/tokens');
    setTokens(data.tokens);
  }, []);
  useEffect(() => { refresh().catch(error => setError(error.message)); }, [refresh]);

  async function create(event) {
    event.preventDefault();
    setBusy(true); setError(''); setToken(null);
    try {
      const data = await integrationApi('/integrations/tokens', { method: 'POST', body: JSON.stringify({
        name, scopes: ['decks:read', ...(proposals ? ['decks:propose'] : []), ...(creation ? ['decks:create'] : [])],
      }) });
      setToken(data.token);
      await refresh();
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function revoke(id) {
    setBusy(true); setError('');
    try { await integrationApi(`/integrations/tokens/${id}`, { method: 'DELETE' }); await refresh(); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }

  return <section className="user-settings-section integration-access">
    <span className="integration-access-eyebrow">Optional · Deck sharing</span>
    <h3>Let ManaSync use your CLC decks</h3>
    <p>This is the other direction: ManaSync reads your deck library from CLC. Create a CLC deck token here, then paste it into ManaSync’s CLC connection under <strong>More → Connected apps</strong>.</p>
    <p>You do not need this step to check ownership or prepare printed proxies in CLC.</p>
    <form className="user-settings-form" onSubmit={create}>
      <label htmlFor="integration-token-name">Connection name</label>
      <input id="integration-token-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required />
      <label className="integration-access-check"><input type="checkbox" checked={proposals} onChange={event => setProposals(event.target.checked)} /> Allow deck proposals for review</label>
      <label className="integration-access-check"><input type="checkbox" checked={creation} onChange={event => setCreation(event.target.checked)} /> Allow immediate creation of new decks</label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Create CLC deck token'}</button>
    </form>
    {token && <div className="integration-token-result">
      <p>Copy this CLC deck token now; it is shown only once. Paste it in ManaSync’s CLC connection, not in the collection connection above.</p>
      <input aria-label="New integration token" readOnly value={token} onFocus={event => event.target.select()} />
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(token).catch(error => setError(error.message))}>Copy token</button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setToken(null)}>Hide token</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {tokens.length > 0 && <ul className="integration-token-list">{tokens.map(item => <li key={item.id}>
      <span><strong>{item.name}</strong> · {item.scopes.includes('decks:propose') ? 'Read and propose' : item.scopes.includes('decks:create') ? 'Read' : 'Read only'}{item.scopes.includes('decks:create') ? ' + create new decks' : ''} · {item.revokedAt ? 'Revoked' : 'Active'}</span>
      {!item.revokedAt && <button type="button" className="btn btn-secondary btn-sm" onClick={() => revoke(item.id)} disabled={busy}>Revoke</button>}
    </li>)}</ul>}
    <details className="integration-access-help"><summary>Deck permissions explained</summary><p>Every token reads digital and paper deck snapshots. Proposals send edits back for your review in CLC. Creation lets ManaSync create a new CLC deck immediately when you choose “Put it in CLC.” Existing tokens keep their current permissions.</p></details>
  </section>;
}
