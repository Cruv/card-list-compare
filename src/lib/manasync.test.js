import { describe,it,expect } from 'vitest';
import { parse } from './parser';
import { deckBridgeCards,printPlanBridgeCards,ownershipFor,withShortages,shoppingText,manaPoolLink } from './manasync';
import { planPhysicalCopies } from '../../server/lib/printQueuePlan.js';
const card={name:'Sol Ring',scryfallId:'print-a',oracleId:'oracle-a',setCode:'c21',collectorNumber:'263',finish:'nonfoil',language:'en'};
const inventory=[{key:'oracle-a',name:'Sol Ring',realOwned:3,incoming:1,received:2,available:1,allocated:1,proxies:6,locations:[]}];
describe('ownership and original-card shopping',() => {
  it('treats unavailable ownership and unresolved exact printing as unknown',() => {
    expect(ownershipFor(card,[], 'oracle',false)).toBeNull();
    expect(ownershipFor({name:'Sol Ring'},[], 'printing',true)).toBeNull();
    expect(ownershipFor(card,[], 'printing',true).realOwned).toBe(0);
    expect(ownershipFor({...card,scryfallId:null},[{...inventory[0],key:'print-a|nonfoil|en'}], 'printing',true)).toBeNull();
  });
  it('counts incoming only once and does not let proxies cover original shortages',() => {
    const rows=withShortages([{key:'a',quantity:5,card}],inventory,'oracle',true);
    expect(rows[0].shortage).toBe(2);expect(rows[0].ownership).toMatchObject({incoming:1,proxies:6,allocated:1});
    expect(shoppingText(rows,false)).toBe('2 Sol Ring');
    expect(shoppingText(rows,true)).toBe('2 Sol Ring (c21) 263');
  });
  it('does not reuse the same originals twice for several deck printings or sections',() => {
    const rows=withShortages([{key:'a',quantity:2,card},{key:'b',quantity:3,card:{...card,scryfallId:'print-b'}}],inventory,'oracle',true);
    expect(rows.map(v=>v.shortage)).toEqual([0,2]);
    const mixed=withShortages([{key:'a',quantity:2,card},{key:'b',quantity:3,card:{...card,oracleId:null}}],inventory,'oracle',true);
    expect(mixed.map(v=>v.shortage)).toEqual([0,2]);
  });
  it('separates exact printings, foil finish, and language',() => {
    const rows=[{...inventory[0],key:'print-a|foil|en'}];
    expect(ownershipFor(card,rows,'printing',true).realOwned).toBe(0);
    expect(ownershipFor({...card,finish:'foil'},rows,'printing',true).realOwned).toBe(3);
    expect(ownershipFor({...card,setCode:'C21'},[{...inventory[0],key:'sol ring|c21|263|nonfoil|en'}],'printing',true).realOwned).toBe(3);
  });
  it('preserves only resolved exact IDs without replacing selected metadata by a random name lookup',() => {
    const parsed=parse('1 Sol Ring (c21) 263\n1 Arcane Signet');
    const map=new Map([['sol ring',{scryfallId:'wrong',oracleId:'oracle-a',setCode:'lea',collectorNumber:'1'}],['arcane signet',{scryfallId:'random',oracleId:'oracle-b'}]]);
    let result=deckBridgeCards(parsed,map);
    expect(result[0].card).toMatchObject({scryfallId:null,oracleId:'oracle-a',setCode:'c21',collectorNumber:'263'});
    expect(result[1].card.scryfallId).toBeNull();
    map.set('sol ring|c21|263|nonfoil',{scryfallId:'exact',oracleId:'oracle-a',setCode:'c21',collectorNumber:'263'});
    result=deckBridgeCards(parsed,map);expect(result[0].card.scryfallId).toBe('exact');
  });
  it('retains each raw line while looking up complete set and finish identities',() => {
    const text='1 Sol Ring (CMM) 410\n2 Sol Ring (CMM) 410 *F*\n1 Sol Ring (LCC) 410';
    const map=new Map([['sol ring|cmm|410|nonfoil',{scryfallId:'cmm-id',oracleId:'oracle-a',setCode:'cmm',collectorNumber:'410'}],['sol ring|cmm|410|foil',{scryfallId:'cmm-id',oracleId:'oracle-a',setCode:'cmm',collectorNumber:'410'}],['sol ring|lcc|410|nonfoil',{scryfallId:'lcc-id',oracleId:'oracle-a',setCode:'lcc',collectorNumber:'410'}]]);
    expect(deckBridgeCards(parse(text),map,text).map(v=>[v.quantity,v.card.scryfallId,v.card.finish])).toEqual([[1,'cmm-id','nonfoil'],[2,'cmm-id','foil'],[1,'lcc-id','nonfoil']]);
  });
  it('uses normalized names and collector casing while keeping unresolved selected printings unknown',() => {
    const text="1 Eowyn’s Sword (LTR) 4A *F*\n1 Sol Ring (C21) 263";
    const map=new Map([["eowyn's sword|ltr|4a|foil",{scryfallId:'exact',oracleId:'oracle-sword',setCode:'ltr',collectorNumber:'4a'}],['sol ring|c21|263|nonfoil',{type:'Other'}],['sol ring',{scryfallId:'wrong',oracleId:'oracle-ring',setCode:'lea',collectorNumber:'1'}]]);
    for (const deckText of [text,undefined]) {
      const cards=deckBridgeCards(parse(text),map,deckText);
      expect(cards[0].card).toMatchObject({scryfallId:'exact',oracleId:'oracle-sword',finish:'foil'});
      expect(cards[1].card).toMatchObject({scryfallId:null,oracleId:'oracle-ring',setCode:'C21',collectorNumber:'263'});
    }
  });
  it('preserves separate CSV printing and finish rows and excludes maybeboard cards',() => {
    const text='Name,Quantity,Set,Collector Number,Finish,Board\nSol Ring,1,CMM,410,nonfoil,mainboard\nSol Ring,2,CMM,410,foil,sideboard\nSol Ring,3,CMM,410,nonfoil,maybeboard';
    const cards=deckBridgeCards(parse(text),new Map(),text);
    expect(cards.map(row => [row.quantity,row.section,row.card.finish])).toEqual([[1,'mainboard','nonfoil'],[2,'sideboard','foil']]);
  });
  it('matches DFC front names and unicode names in ownership fallback and encodes Mana Pool UTF-8',() => {
    const rows=[{...inventory[0],key:'different-oracle',name:'Éowyn // Back'}];
    expect(ownershipFor({name:'Eowyn'},rows,'oracle',true).realOwned).toBe(3);
    const text='2 Éowyn\n1 Sol Ring';const url=new URL(manaPoolLink(text));
    expect(url.pathname).toBe('/add-deck');
    expect(Buffer.from(url.searchParams.get('deck'),'base64').toString('utf8')).toBe(text);
  });
});

describe('ownership and shopping for the reviewed physical print plan', () => {
  const target = 'Commander\n1 Partner\n\n5 Sol Ring (CMM) 410\n2 Island\nSideboard\n2 Negate';
  const baseline = 'Commander\n1 Partner\n\n2 Sol Ring (CMM) 410\n2 Island\nSideboard\n1 Negate';
  const map = new Map([
    ['sol ring|cmm|410|nonfoil',{scryfallId:'print-cmm',oracleId:'oracle-a',setCode:'cmm',collectorNumber:'410'}],
    ['sol ring|c21|263|nonfoil',{scryfallId:'print-c21',oracleId:'oracle-a',setCode:'c21',collectorNumber:'263'}],
    ['sol ring',{scryfallId:'generic-print',oracleId:'oracle-a',setCode:'lea',collectorNumber:'1'}],
  ]);

  it.each([
    ['full',false,[['Sol Ring',5],['Island',2],['Partner',1]]],
    ['full',true,[['Sol Ring',5],['Island',2],['Partner',1],['Negate',2]]],
    ['changes',false,[['Sol Ring',3]]],
    ['changes',true,[['Sol Ring',3],['Negate',1]]],
  ])('uses only %s plan copies with includeSideboard=%s', (mode,includeSideboard,expected) => {
    const plan = {mode,includeSideboard,cards:planPhysicalCopies(target,mode === 'changes' ? baseline : null,{includeSideboard}),
      target:{id:7,text:target},source:{id:5,text:baseline}};
    const rows = printPlanBridgeCards(plan,map);
    expect(rows.map(row => [row.card.name,row.quantity])).toEqual(expected);
    expect(rows.find(row => row.card.name === 'Sol Ring').card).toMatchObject({scryfallId:'print-cmm',setCode:'CMM',collectorNumber:'410'});
    expect(shoppingText(withShortages(rows,[],'oracle',true),false)).toBe(expected.map(([name,quantity]) => `${quantity} ${name}`).join('\n'));
  });

  it('does not replace an empty reviewed plan with target snapshot or latest deck text', () => {
    const plan = {mode:'changes',cards:[],target:{id:7,text:target},deckText:target};
    expect(printPlanBridgeCards(plan,map)).toEqual([]);
    expect(shoppingText(withShortages(printPlanBridgeCards(plan,map),[],'oracle',true),false)).toBe('');
  });

  it('shares originals across selected duplicate printings and counts incoming once without using proxies', () => {
    const plan = {cards:[
      {displayName:'Sol Ring',quantity:2,setCode:'CMM',collectorNumber:'410',isFoil:false},
      {displayName:'Sol Ring',quantity:3,setCode:'C21',collectorNumber:'263',isFoil:false},
    ]};
    const cards = printPlanBridgeCards(plan,map);
    expect(new Set(cards.map(row => row.key)).size).toBe(2);
    const rows = withShortages(cards,inventory,'oracle',true);
    expect(rows.map(row => row.shortage)).toEqual([0,2]);
    expect(shoppingText(rows,false)).toBe('2 Sol Ring');
    expect(withShortages(cards,[{...inventory[0],realOwned:2,incoming:0}],'oracle',true).map(row => row.shortage)).toEqual([0,3]);
    expect(withShortages(cards,[{...inventory[0],proxies:100}],'oracle',true).map(row => row.shortage)).toEqual([0,2]);
  });

  it('matches selected printings exactly and preserves the physical planner’s nonfoil output', () => {
    const cards = printPlanBridgeCards({cards:planPhysicalCopies('1 Sol Ring (CMM) 410 *F*\n2 Sol Ring (CMM) 410',null)},map);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({quantity:3,card:{finish:'nonfoil',scryfallId:'print-cmm'}});
    const rows = withShortages(cards,[{...inventory[0],key:'print-c21|nonfoil|en'}],'printing',true);
    expect(rows[0].shortage).toBe(3);
    expect(shoppingText(rows,true)).toBe('3 Sol Ring (CMM) 410');
  });

  it('omits buy text while ownership is unavailable or the selected exact identity is unresolved', () => {
    const plan = {cards:[{displayName:'Sol Ring',quantity:3,setCode:'CMM',collectorNumber:'410',isFoil:false}]};
    const cards = printPlanBridgeCards(plan,map);
    const disconnected = withShortages(cards,inventory,'oracle',false);
    expect(disconnected[0].shortage).toBeNull();
    expect(shoppingText(disconnected,false)).toBe('');
    const unresolved = withShortages(printPlanBridgeCards(plan,new Map([['sol ring',map.get('sol ring')]])),[],'printing',true);
    expect(unresolved[0].card).toMatchObject({scryfallId:null,oracleId:'oracle-a',setCode:'CMM',collectorNumber:'410'});
    expect(unresolved[0].shortage).toBeNull();
    expect(shoppingText(unresolved,true)).toBe('');
  });
});
