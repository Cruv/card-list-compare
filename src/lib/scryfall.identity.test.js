import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { fetchCardData,clearCardCache,collectDeckIdentifiers } from './scryfall';
import { parse } from './parser.js';
import { cardIdentityKey } from './cardIdentity.js';
import { deckBridgeCards } from './manasync.js';

beforeEach(() => {
  vi.useFakeTimers();clearCardCache();
  vi.stubGlobal('fetch',vi.fn(async (_url,options) => {
    const identifiers=JSON.parse(options.body).identifiers;
    const seen=new Set();
    return {ok:true,json:async () => ({data:identifiers.filter(v=>{const key=`${v.set}|${v.collector_number}`;if(seen.has(key))return false;seen.add(key);return true;}).map(v=>({
      id:`${v.set || 'generic'}-id`,oracle_id:'oracle-id',name:'Sol Ring',set:v.set || 'generic',collector_number:v.collector_number || '1',
      type_line:'Artifact',mana_cost:'{1}',prices:{usd:'1.00'},color_identity:[],image_uris:{normal:'https://cards.scryfall.io/test.jpg'},
    }))})};
  }));
});
afterEach(() => {vi.runOnlyPendingTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe('resolved printing identity in the client Scryfall map',() => {
  it('retains oracle/printing identity for both finishes through result maps and cache',async () => {
    const identifiers=new Map([['sol ring|cmm|410|nonfoil',{name:'Sol Ring',set:'cmm',collector_number:'410'}],['sol ring|cmm|410|foil',{name:'Sol Ring',set:'cmm',collector_number:'410'}]]);
    const result=await fetchCardData(identifiers);
    for (const key of identifiers.keys()) expect(result.get(key)).toMatchObject({scryfallId:'cmm-id',oracleId:'oracle-id',setCode:'cmm',collectorNumber:'410'});
    const cached=await fetchCardData(identifiers);expect(cached.get('sol ring|cmm|410|foil').scryfallId).toBe('cmm-id');expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not reuse another set’s cache entry when collector numbers coincide',async () => {
    await fetchCardData(new Map([['sol ring|cmm|410|nonfoil',{name:'Sol Ring',set:'cmm',collector_number:'410'}]]));
    const result=await fetchCardData(new Map([['sol ring|c21|410|nonfoil',{name:'Sol Ring',set:'c21',collector_number:'410'}]]));
    expect(result.get('sol ring|c21|410|nonfoil').scryfallId).toBe('c21-id');expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('passes complete parser identities through Scryfall into ManaSync without generic printing substitution',async () => {
    const text='1 Sol Ring (CMM) 410\n2 Sol Ring (CMM) 410 *F*\n3 Sol Ring (C21) 410\n1 Sol Ring';
    const parsed=parse(text);
    const identifiers=collectDeckIdentifiers(parsed);
    const map=await fetchCardData(identifiers);
    for (const entry of parsed.mainboard.values()) expect(map.has(cardIdentityKey(entry))).toBe(true);
    for (const deckText of [text,undefined]) {
      expect(deckBridgeCards(parsed,map,deckText).map(row => [row.quantity,row.card.scryfallId,row.card.oracleId,row.card.finish])).toEqual([
        [1,'cmm-id','oracle-id','nonfoil'],[2,'cmm-id','oracle-id','foil'],[3,'c21-id','oracle-id','nonfoil'],[1,null,'oracle-id','nonfoil'],
      ]);
    }
  });
});
