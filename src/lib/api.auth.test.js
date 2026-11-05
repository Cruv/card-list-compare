import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMe } from './api';

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'existing-credential'), removeItem: vi.fn() });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('account validation credential handling', () => {
  it('keeps a recoverable credential when the network is unavailable', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(getMe()).rejects.toThrow('Network error');
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500, 503])('does not turn HTTP %s into a sign-out', async status => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Try again later' }), { status }));
    await expect(getMe()).rejects.toMatchObject({ status });
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('discards a genuinely unauthorized credential and notifies the auth provider', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Expired token' }), { status: 401 }));
    await expect(getMe()).rejects.toThrow('Session expired');
    expect(localStorage.removeItem).toHaveBeenCalledWith('clc-auth-token');
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth-expired' }));
  });
});
