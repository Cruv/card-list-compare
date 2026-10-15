import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMpcOverrides, saveMpcOverrides } from './api';

afterEach(() => vi.unstubAllGlobals());

function setup(body, status = 200) {
  vi.stubGlobal('localStorage', { getItem: () => 'session-token', removeItem: vi.fn() });
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('versioned saved artwork requests', () => {
  it('sends the acknowledged revision with the complete authenticated artwork record', async () => {
    const fetcher = setup({ saved: true, count: 1, revision: 8 });
    const overrides = [['sol ring', { identifier: 'art' }]];
    await expect(saveMpcOverrides(12, overrides, 7)).resolves.toMatchObject({ revision: 8 });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/decks/12/mpc-overrides', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ overrides, baseRevision: 7 }),
      headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
    }));
  });

  it('retains the conflict snapshot for explicit UI recovery without retrying', async () => {
    const body = { error: 'Artwork changed', code: 'ARTWORK_CONFLICT', overrides: [['card', { identifier: 'newer' }]], configured: true, revision: 9 };
    const fetcher = setup(body, 409);
    await expect(saveMpcOverrides(12, [], 7)).rejects.toMatchObject({ status: 409, data: body, message: 'Artwork changed' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns versioned reset snapshots and preserves required-revision errors', async () => {
    setup({ overrides: [], configured: true, revision: 0 });
    await expect(getMpcOverrides(12)).resolves.toEqual({ overrides: [], configured: true, revision: 0 });
    setup({ error: 'Reload CLC', code: 'ARTWORK_REVISION_REQUIRED' }, 428);
    await expect(saveMpcOverrides(12, [])).rejects.toMatchObject({ status: 428, data: { code: 'ARTWORK_REVISION_REQUIRED' } });
  });

  it('still expires unauthorized sessions without leaking a conflict snapshot', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    setup({ error: 'Unauthorized' }, 401);
    await expect(getMpcOverrides(12)).rejects.toThrow('Session expired');
    expect(localStorage.removeItem).toHaveBeenCalledWith('clc-auth-token');
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth-expired' }));
  });
});
