import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getManaSyncAvailability, queuePrintItem, queuePrintBatch } from '../lib/api';
import { deckBridgeCards, withShortages, shoppingText, manaPoolLink } from '../lib/manasync';
import { createOperationId } from '../lib/operationId';
import CopyButton from './CopyButton';
import PrintQueue from './PrintQueue';
import './ManaSync.css';

export default function ManaSyncOwnership({deckId,parsedDeck,cardMap,deckText,cards:selectionCards,showConfirmations=true,initiallyOpen=false}) {
  const refreshSequence = useRef(0);
  const [by,setBy] = useState('oracle');
  const [data,setData] = useState(null);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const [selected,setSelected] = useState({});
  const [queueRevision,setQueueRevision] = useState(0);
  const [queueing,setQueueing] = useState(null);
  const cards = useMemo(() => selectionCards ?? deckBridgeCards(parsedDeck,cardMap,deckText),[selectionCards,parsedDeck,cardMap,deckText]);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setLoading(true);setError('');
    try {const result = await getManaSyncAvailability(by);if (sequence === refreshSequence.current) setData({...result,by});}
    catch(e) {if (sequence === refreshSequence.current) {setData(previous => ({...previous,known:false}));setError(e.message);}}
    finally {if (sequence === refreshSequence.current) setLoading(false);}
  },[by]);
  useEffect(() => {void refresh();},[refresh]);
  const rows = useMemo(() => withShortages(cards,data?.availability || [],by,data?.known && data.by === by && !loading),[cards,data,by,loading]);
  const shopping = shoppingText(rows.filter(row => selected[row.key] !== false),by === 'printing');
  const shoppingUrl = shopping && manaPoolLink(shopping);
  async function queue(entry) {
    setQueueing(entry.key);setError('');
    const key = `clc-queue-request:${deckId}:${entry.key}`;
    try {
      const saved = localStorage.getItem(key);
      const request = saved ? JSON.parse(saved) : {id:createOperationId(),deckId,quantity:entry.quantity,card:entry.card};
      localStorage.setItem(key,JSON.stringify(request));
      await queuePrintItem(request);
      localStorage.removeItem(key);setQueueRevision(value => value+1);
    } catch(e) {if (e.status >= 400 && e.status < 500) localStorage.removeItem(key);setError(`${e.message} Retrying an uncertain queue action preserves its original request.`);} finally {setQueueing(null);}
  }
  async function queueDeck() {
    setQueueing('deck');setError('');
    const key = `clc-queue-deck:${deckId}`;
    try {
      const saved = localStorage.getItem(key);
      const request = saved ? JSON.parse(saved) : cards.map(entry => ({id:createOperationId(),deckId,quantity:entry.quantity,card:entry.card}));
      localStorage.setItem(key,JSON.stringify(request));
      await queuePrintBatch(request);localStorage.removeItem(key);setQueueRevision(value => value+1);
    } catch(e) {if (e.status >= 400 && e.status < 500) localStorage.removeItem(key);setError(e.message);} finally {setQueueing(null);}
  }
  return <section className="mana-sync">
    {showConfirmations && <>
      <button className="btn btn-secondary btn-sm" type="button" onClick={queueDeck} disabled={!!queueing || !cards.length}>{queueing === 'deck' ? 'Queueing…' : 'Queue full deck for printing'}</button>
      <p>This list tracks quantities for later inventory confirmation. Use the Printing tab to generate PDFs or send a batch to the Mac. Confirm only usable physical copies below to record them in ManaSync.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    <details open={initiallyOpen || undefined}>
      <summary>ManaSync ownership and Mana Pool shopping</summary>
      <div className="mana-sync-actions"><label>Match <select value={by} onChange={e => {setBy(e.target.value);setData(null);}}><option value="oracle">Interchangeable printings</option><option value="printing">Exact printing and finish</option></select></label>
        <button className="btn btn-secondary btn-sm" onClick={refresh} disabled={loading} type="button">{loading ? 'Refreshing…' : 'Refresh ownership'}</button></div>
      <p>{data?.known ? 'Ownership from ManaSync' : 'Ownership unknown. Connect or reconnect ManaSync in Settings.'} · Last successful ownership refresh: {data?.connection?.lastOwnership ? new Date(data.connection.lastOwnership).toLocaleString() : 'Never'}</p>
      {data?.error && <p role="status">{data.error}</p>}
      <p>Originals include incoming cards and cards allocated to other decks. Reusable proxies are shown separately. Select real-card shortages to prepare a Mana Pool list.</p>
      <div className="mana-sync-table-wrap"><table><thead><tr><th>Shop</th><th>Card</th><th>Need</th><th>Free originals</th><th>In decks</th><th>Incoming</th><th>Proxies</th><th>Shortage</th>{showConfirmations && <th>Printing</th>}</tr></thead><tbody>
        {rows.map(row => <tr key={row.key}>
          <td><input type="checkbox" aria-label={`Shop for ${row.card.name}`} checked={selected[row.key] !== false && row.shortage > 0} disabled={!row.shortage} onChange={e => setSelected(previous => ({...previous,[row.key]:e.target.checked}))} /></td>
          <td>{row.card.name}{by === 'printing' && <small> {row.card.setCode.toUpperCase()} {row.card.collectorNumber} · {row.card.finish}</small>}
            {!!row.ownership?.locations?.length && <details><summary>Locations</summary>{row.ownership.locations.map((location,i) => <div key={`${location.containerId}:${i}`}>{location.quantity} {location.isProxy ? 'proxies' : 'originals'} · {location.name} ({location.kind})</div>)}</details>}</td>
          <td>{row.quantity}</td><td>{row.ownership?.available ?? '?'}</td><td>{row.ownership?.allocated ?? '?'}</td><td>{row.ownership?.incoming ?? '?'}</td><td>{row.ownership?.proxies ?? '?'}</td><td>{row.shortage ?? '?'}</td>
          {showConfirmations && <td><button className="btn btn-secondary btn-sm" type="button" disabled={!!queueing} onClick={() => queue(row)}>{queueing === row.key ? 'Queueing…' : `Queue ${row.quantity}`}</button></td>}
        </tr>)}
      </tbody></table></div>
      <div className="mana-sync-actions">{shopping && <CopyButton getText={() => shopping} label="Copy selected shortages" />}
        {shoppingUrl && shoppingUrl.length < 7500 && <a className="btn btn-primary btn-sm" href={shoppingUrl} target="_blank" rel="noreferrer">Review in Mana Pool</a>}</div>
      {shoppingUrl?.length >= 7500 && <p>This list is too long for a reliable link. Copy it and paste it into <a href="https://manapool.com/add-deck" target="_blank" rel="noreferrer">Mana Pool Add Deck</a>.</p>}
      {shopping && by === 'printing' && <p>The list preserves set and collector number. Review foil and language options in Mana Pool.</p>}
      {shopping && <textarea className="mana-sync-list" aria-label="Selected original-card shopping list" readOnly rows={Math.min(8,shopping.split('\n').length+1)} value={shopping} />}
    </details>
    {showConfirmations && <PrintQueue deckId={deckId} refreshKey={queueRevision} onReported={refresh} />}
  </section>;
}
