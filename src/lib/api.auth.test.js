import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changePassword, getMe, login } from './api';

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
    fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Expired token', code: 'SESSION_INVALID' }), { status: 401 }));
    await expect(getMe()).rejects.toThrow('Session expired');
    expect(localStorage.removeItem).toHaveBeenCalledWith('clc-auth-token');
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth-expired' }));
  });

  it.each([
    ['login', () => login('fixture', 'wrong'), 'Invalid username or password'],
    ['change password', () => changePassword('wrong', 'NewPassword1'), 'Current password is incorrect'],
  ])('keeps the session on incorrect credentials for %s', async (_, request, message) => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ error: message, code: 'INVALID_CREDENTIALS' }), { status: 401 }));
    await expect(request()).rejects.toMatchObject({ status: 401, message });
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('does not clear a replacement session when an earlier request expires', async () => {
    const pending = Promise.withResolvers();
    fetch.mockReturnValue(pending.promise);
    const request = getMe();
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer existing-credential' }) }));
    localStorage.getItem.mockReturnValue('replacement-credential');
    pending.resolve(new Response(JSON.stringify({ error: 'Expired token', code: 'SESSION_INVALID' }), { status: 401 }));
    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
});
