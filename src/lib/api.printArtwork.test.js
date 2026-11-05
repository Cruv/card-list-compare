import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPrintQueueArtwork, stagePrintJobConfirmations } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('print batch artwork client requests', () => {
  it('stages only a batch confirmation queue without confirming any inventory', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'session-token' });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ jobId: 'job-a', items: [] })));
    vi.stubGlobal('fetch', fetcher);

    await expect(stagePrintJobConfirmations('job-a')).resolves.toMatchObject({ jobId: 'job-a' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([
      '/api/manasync/print-jobs/job-a/confirmation-queue',
      expect.objectContaining({ method: 'POST', body: '{}', headers: expect.objectContaining({ Authorization: 'Bearer session-token' }) }),
    ]);
  });

  it('fetches artwork through the authenticated local route with abort support', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'session-token' });
    const fetcher = vi.fn(async () => new Response('saved-image', { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();

    const blob = await getPrintQueueArtwork('item-a', 'back', controller.signal);
    expect(await blob.text()).toBe('saved-image');
    expect(fetcher).toHaveBeenCalledWith('/api/manasync/print-queue/item-a/artwork/back', {
      headers: { Authorization: 'Bearer session-token' }, signal: controller.signal,
    });
    await expect(getPrintQueueArtwork('item-a', 'https://other.example/image')).rejects.toThrow('Invalid artwork face');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves useful backend errors when saved artwork is unavailable', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Saved artwork is unavailable' }), { status: 410 })));
    await expect(getPrintQueueArtwork('item-a', 'front')).rejects.toThrow('Saved artwork is unavailable');
  });
});
