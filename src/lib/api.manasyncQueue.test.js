import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrintQueue, refreshPendingProxyPrints, retryPendingProxyPublication } from './api';

let fetcher;
beforeEach(() => {
  vi.stubGlobal('localStorage', {getItem: () => 'clc-session'});
  fetcher = vi.fn(async () => new Response(JSON.stringify({items:[]})));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe('ManaSync print-record client requests', () => {
  it('keeps routine queue reads local and scopes deliberate remote refreshes to the reviewed batch', async () => {
    await getPrintQueue(7);
    await refreshPendingProxyPrints({deckId:7,printJobId:'batch-id',unrelated:'discarded'});
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/manasync/print-queue?deckId=7','/api/manasync/print-queue/refresh',
    ]);
    const options = fetcher.mock.calls[1][1];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({deckId:7,printJobId:'batch-id'});
    expect(options.headers.Authorization).toBe('Bearer clc-session');
  });

  it('supports standalone and account-wide review without inventing a deck scope', async () => {
    await refreshPendingProxyPrints({printJobId:'standalone-id'});
    await refreshPendingProxyPrints();
    expect(fetcher.mock.calls.map(([,options]) => JSON.parse(options.body))).toEqual([
      {printJobId:'standalone-id'}, {},
    ]);
  });

  it('retries only the saved publication with the reviewed connection and no new print or inventory request', async () => {
    const connection = {baseUrl:'https://mana.example',accountId:'account',actorId:'actor'};
    await retryPendingProxyPublication('item/id',connection);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([
      '/api/manasync/print-queue/item%2Fid/retry-publication',
      expect.objectContaining({method:'POST',body:JSON.stringify({expectedConnection:connection})}),
    ]);
  });
});
