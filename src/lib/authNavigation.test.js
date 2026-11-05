import { describe, expect, it, vi } from 'vitest';
import { clearPasswordResetUrl } from './authNavigation';

function browserAt(address) {
  const browser = {
    location: new URL(address),
    dispatchEvent: vi.fn(),
    HashChangeEvent: class { constructor(type, fields) { this.type = type; Object.assign(this, fields); } },
  };
  browser.history = { replaceState: vi.fn((_state, _title, path) => { browser.location = new URL(path, browser.location); }) };
  return browser;
}

describe('completed password-reset navigation', () => {
  it('clears the private token and notifies the router when returning from another hash route', () => {
    const browser = browserAt('https://clc.example/?reset=one-time-token#guide');
    clearPasswordResetUrl(browser);
    expect(browser.location.href).toBe('https://clc.example/');
    expect(browser.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'hashchange', oldURL: 'https://clc.example/?reset=one-time-token#guide', newURL: 'https://clc.example/' }));
    clearPasswordResetUrl(browser);
    expect(browser.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('does not invent a route transition when a reset link has no hash', () => {
    const browser = browserAt('https://clc.example/?reset=one-time-token');
    clearPasswordResetUrl(browser);
    expect(browser.location.search).toBe('');
    expect(browser.dispatchEvent).not.toHaveBeenCalled();
  });
});
