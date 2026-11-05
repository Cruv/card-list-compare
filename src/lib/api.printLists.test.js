import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStandalonePrintJob, previewStandalonePrintJob, downloadPrintArtifact } from './api';

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 'fixture-user-token' });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('standalone print requests', () => {
  it('keeps the entire edited order and original request key for authenticated creation', async () => {
    const body = { mode: 'adhoc', listName: 'Friday cards', cardText: '2 Lightning Bolt',
      additionalCardText: '1 Sol Ring', excludedCards: ['lightning bolt||'], excludeBasicLands: true,
      expectedPlanHash: 'a'.repeat(64), idempotencyKey: 'b'.repeat(48), queueOnReady: false };
    fetch.mockResolvedValue(new Response(JSON.stringify({ job: { id: 'new-batch', deckId: null } })));
    await createStandalonePrintJob(body);
    expect(fetch.mock.calls[0][0]).toBe('/api/print-lists/jobs');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-user-token');
  });

  it('allows full metadata resolution time for both standalone preview and creation', async () => {
    vi.useFakeTimers();
    fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    let failures = 0;
    const requests = [previewStandalonePrintJob({}), createStandalonePrintJob({})].map(request =>
      request.catch(error => { failures++; throw error; }));
    const rejected = requests.map(request => expect(request).rejects.toThrow('Request timed out'));
    await vi.advanceTimersByTimeAsync(89_999); expect(failures).toBe(0);
    await vi.advanceTimersByTimeAsync(1); await Promise.all(rejected);
  });

  it.each([
    'https://example.com/api/print-lists/jobs/a/manifest',
    '//example.com/api/print-lists/jobs/a/manifest',
    '/api/print-lists/jobs/a/../../auth/me',
    '/api/print-lists/jobs/a/artifacts/%2E%2E',
    '/api/print-lists/jobs/a/manifest?redirect=https://example.com',
    '/api/decks/1/print-jobs/a/../../auth/me',
  ])('refuses a non-artifact address before exposing the bearer token: %s', async url => {
    await expect(downloadPrintArtifact(url)).rejects.toThrow('Invalid PDF download address');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['/api/print-lists/jobs/job-a/manifest', '/api/print-lists/jobs/job-a/artifacts/double-faced-001', '/api/decks/1/print-jobs/job-a/artifacts/fronts'])('accepts only scoped local manifest/PDF paths: %s', async url => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Artifact expired' }), { status: 410 }));
    await expect(downloadPrintArtifact(url)).rejects.toThrow('Artifact expired');
    expect(fetch).toHaveBeenCalledWith(url, { headers: { Authorization: 'Bearer fixture-user-token' } });
  });
});
