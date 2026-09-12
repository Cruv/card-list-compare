import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getManaSyncAvailability, queuePrintItem, queuePrintBatch } from '../lib/api';
import { deckBridgeCards, withOriginalOwnership, shoppingText, manaPoolLink } from '../lib/manasync';
import { createOperationId } from '../lib/operationId';
import CopyButton from './CopyButton';
import PrintQueue from './PrintQueue';
import './ManaSync.css';

export default function ManaSyncOwnership({deckId,parsedDeck,cardMap,deckText,cards:selectionCards,showConfirmations=true,initiallyOpen=false,onRowsChange,visibleKeys,shoppingDisabled=false}) {
  const refreshSequence = useRef(0);
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
    try {const result = await getManaSyncAvailability('oracle');if (sequence === refreshSequence.current) setData(result);}
    catch(e) {if (sequence === refreshSequence.current) {setData(previous => ({...previous,known:false}));setError(e.message);}}
    finally {if (sequence === refreshSequence.current) setLoading(false);}
  },[]);
  useEffect(() => {void refresh();},[refresh]);
  const rows = useMemo(() => withOriginalOwnership(cards,data?.availability || [],data?.known && !loading),[cards,data,loading]);
  useEffect(() => { onRowsChange?.(rows); }, [onRowsChange, rows]);
  const rowsByKey = new Map(rows.map(row => [row.key, row]));
  const displayedRows = visibleKeys ? visibleKeys.map(key => rowsByKey.get(key)).filter(Boolean) : rows;
  const shopping = shoppingDisabled ? '' : shoppingText(displayedRows.filter(row => selected[row.shoppingKey] !== false));
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
      <div className="mana-sync-actions"><button className="btn btn-secondary btn-sm" onClick={refresh} disabled={loading} type="button">{loading ? 'Refreshing…' : 'Refresh ownership'}</button></div>
      <p>{data?.known ? 'Ownership from ManaSync' : 'Ownership unknown. Connect or reconnect ManaSync in Settings.'} · Last successful ownership refresh: {data?.connection?.lastOwnership ? new Date(data.connection.lastOwnership).toLocaleString() : 'Never'}</p>
      {data?.error && <p role="status">{data.error}</p>}
      <p>One original in any printing covers unlimited proxy copies across all your decks, including originals already in another deck. Incoming originals also count so you do not buy them again. Proxies do not count as originals.</p>
      <p>Select a card only to add one original to your Mana Pool shopping list. This does not place an order or change any print quantities. Different printings of the same card share one shopping selection.</p>
      <div className="mana-sync-table-wrap"><table><thead><tr><th>Buy one original</th><th>Card</th><th>Owned or incoming</th>{showConfirmations && <th>Printing</th>}</tr></thead><tbody>
        {displayedRows.map(row => <tr key={row.key}>
          <td><input type="checkbox" aria-label={`Include one ${row.card.name} original in the Mana Pool list`} checked={selected[row.shoppingKey] !== false && row.ownership?.hasOriginal === false} disabled={shoppingDisabled || row.ownership?.hasOriginal !== false} onChange={e => setSelected(previous => ({...previous,[row.shoppingKey]:e.target.checked}))} /></td>
          <td>{row.card.name}<small> {row.quantity} {row.quantity === 1 ? 'copy' : 'copies'} in this list{row.card.setCode ? ` · ${row.card.setCode.toUpperCase()} ${row.card.collectorNumber}` : ''}</small>
            {!!row.ownership?.locations?.length && <details><summary>Original locations</summary>{row.ownership.locations.map((location,i) => <div key={`${location.containerId}:${i}`}>{location.name} ({location.kind})</div>)}</details>}</td>
          <td>{!row.ownership ? 'Unknown' : row.ownership.hasOriginal ? row.ownership.incomingOnly ? 'Yes — incoming original' : 'Yes' : 'No original found'}</td>
          {showConfirmations && <td><button className="btn btn-secondary btn-sm" type="button" disabled={!!queueing} onClick={() => queue(row)}>{queueing === row.key ? 'Queueing…' : `Queue ${row.quantity}`}</button></td>}
        </tr>)}
      </tbody></table></div>
      {!displayedRows.length && <p>No cards match the current review filters.</p>}
      {visibleKeys && <p>Shopping includes only the missing originals selected in the current filtered view. Owned, incoming and unknown cards are excluded. Printing still uses the entire reviewed batch.</p>}
      {shoppingDisabled && <p role="status">Review the updated list to build its buy list.</p>}
      <div className="mana-sync-actions">{shopping && <CopyButton getText={() => shopping} label={visibleKeys ? 'Copy missing cards in this view' : 'Copy original-card shopping list'} />}
        {shoppingUrl && shoppingUrl.length < 7500 && <a className="btn btn-primary btn-sm" href={shoppingUrl} target="_blank" rel="noreferrer">{visibleKeys ? 'Review missing cards in Mana Pool' : 'Review in Mana Pool'}</a>}</div>
      {shoppingUrl?.length >= 7500 && <p>This list is too long for a reliable link. Copy it and paste it into <a href="https://manapool.com/add-deck" target="_blank" rel="noreferrer">Mana Pool Add Deck</a>.</p>}
      {shopping && <p>The list requests one original per card, in any printing. Choose your preferred printing, finish and language in Mana Pool.</p>}
      {shopping && <textarea className="mana-sync-list" aria-label="Selected original-card shopping list" readOnly rows={Math.min(8,shopping.split('\n').length+1)} value={shopping} />}
    </details>
    {showConfirmations && <PrintQueue deckId={deckId} refreshKey={queueRevision} onReported={refresh} />}
  </section>;
}
