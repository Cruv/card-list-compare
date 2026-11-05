import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mpc;
const response = data => ({ ok: true, json: async () => data });

function mockApi({ sources = { results: { b: { pk: 9, name: 'Second' }, a: { pk: 2, name: 'First' } } },
  languages = { languages: [{ code: 'EN', name: 'English' }, { code: 'JA', name: 'Japanese' }] } } = {}) {
  const fetcher = vi.fn(async (url, options) => {
    if (url.endsWith('/sources/')) return response(sources);
    if (url.endsWith('/languages/')) return response(languages);
    if (url.endsWith('/editorSearch/')) {
      const { queries } = JSON.parse(options.body);
      return response({ results: Object.fromEntries(queries.map(({ query }) => [query, { CARD: ['art-1'] }])) });
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function searches(fetcher) {
  return fetcher.mock.calls.filter(([url]) => url.endsWith('/editorSearch/')).map(([, options]) => JSON.parse(options.body));
}

beforeEach(async () => {
  vi.resetModules();
  mpc = await import('./mpcautofill.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MPC search filter resolution', () => {
  it('expands default empty filters to all actual sources and languages', async () => {
    const fetcher = mockApi();
    const result = await mpc.searchCards(['Lightning Bolt', 'Sol Ring']);
    const [request] = searches(fetcher);
    expect(request.searchSettings.sourceSettings.sources).toEqual([[2, true], [9, true]]);
    expect(request.searchSettings.filterSettings.languages).toEqual(['EN', 'JA']);
    expect(request.searchSettings.filterSettings.excludesTags).toEqual(['NSFW']);
    expect(result.get('lightning bolt')).toEqual(['art-1']);
    expect(result.get('sol ring')).toEqual(['art-1']);
  });

  it('preserves explicit source order, disabled sources and language restrictions', async () => {
    const fetcher = mockApi();
    const settings = Object.freeze({
      sourceSettings: Object.freeze({ sources: Object.freeze([[9, false], [2, true]]) }),
      filterSettings: Object.freeze({ languages: Object.freeze(['JA']), minimumDPI: 600 }),
      searchTypeSettings: Object.freeze({ fuzzySearch: true }),
    });
    await mpc.searchCards(['Sol Ring'], settings);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [request] = searches(fetcher);
    expect(request.searchSettings.sourceSettings.sources).toEqual([[9, false], [2, true]]);
    expect(request.searchSettings.filterSettings.languages).toEqual(['JA']);
    expect(request.searchSettings.filterSettings.minimumDPI).toBe(600);
    expect(request.searchSettings.searchTypeSettings.fuzzySearch).toBe(true);
  });

  it('uses resolved settings for the cache and does not mutate empty UI filters', async () => {
    const fetcher = mockApi();
    const settings = Object.freeze({
      sourceSettings: Object.freeze({ sources: Object.freeze([]) }),
      filterSettings: Object.freeze({ languages: Object.freeze([]) }),
    });
    await mpc.searchCards(['Sol Ring'], settings);
    const resolved = searches(fetcher)[0].searchSettings;
    await mpc.searchCards(['Sol Ring'], resolved);
    await mpc.searchCards(['Sol Ring']);
    expect(searches(fetcher)).toHaveLength(1);
    expect(settings.sourceSettings.sources).toEqual([]);
    expect(settings.filterSettings.languages).toEqual([]);
  });

  it('keeps different source order and disabled choices in different cache entries', async () => {
    const fetcher = mockApi();
    const settings = { sourceSettings: { sources: [[2, true], [9, false]] }, filterSettings: { languages: ['EN'] } };
    await mpc.searchCards(['Sol Ring'], settings);
    await mpc.searchCards(['Sol Ring'], { ...settings, sourceSettings: { sources: [[9, false], [2, true]] } });
    await mpc.searchCards(['Sol Ring'], { ...settings, sourceSettings: { sources: [[2, true], [9, true]] } });
    expect(searches(fetcher)).toHaveLength(3);
  });

  it.each(['sources', 'languages'])('fails explicitly when %s metadata is unavailable and retries without false no-match caching', async kind => {
    const fetcher = mockApi();
    const normal = fetcher.getMockImplementation();
    let failed = true;
    fetcher.mockImplementation((url, options) => failed && url.endsWith(`/${kind}/`)
      ? Promise.resolve({ ok: false, status: 503 }) : normal(url, options));
    await expect(mpc.searchCards(['Lightning Bolt'])).rejects.toMatchObject({ status: 503 });
    expect(searches(fetcher)).toHaveLength(0);
    failed = false;
    expect((await mpc.searchCards(['Lightning Bolt'])).get('lightning bolt')).toEqual(['art-1']);
    expect(searches(fetcher)).toHaveLength(1);
  });

  it.each([
    ['sources', { results: {} }, 'getSources'],
    ['sources', { results: { invalid: { pk: null } } }, 'getSources'],
    ['languages', { languages: [] }, 'getLanguages'],
    ['languages', { languages: [{ name: 'Missing code' }] }, 'getLanguages'],
  ])('rejects malformed or empty %s metadata', async (kind, invalid, method) => {
    mockApi({ [kind]: invalid });
    await expect(mpc[method]()).rejects.toMatchObject({ status: 503 });
  });

  it('refreshes expanded metadata after its TTL and searches using the new source set', async () => {
    vi.useFakeTimers();
    const fetcher = mockApi();
    await mpc.searchCards(['Sol Ring']);
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
    const normal = fetcher.getMockImplementation();
    fetcher.mockImplementation((url, options) => url.endsWith('/sources/')
      ? Promise.resolve(response({ results: { new: { pk: 10, name: 'New source' } } })) : normal(url, options));
    await mpc.searchCards(['Sol Ring']);
    expect(searches(fetcher)[1].searchSettings.sourceSettings.sources).toEqual([[10, true]]);
  });
});
