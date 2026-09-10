import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationId } from './operationId';

afterEach(() => vi.unstubAllGlobals());

describe('bridge operation IDs across browser contexts', () => {
  it('uses the browser UUID implementation when available', () => {
    const uuid = '942689af-89db-4c1c-8099-c6fb5b5f2369';
    const randomUUID = vi.fn(() => uuid);
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });

    expect(createOperationId()).toBe(uuid);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('produces valid version-4 UUIDs from fresh cryptographic bytes on HTTP LAN origins', () => {
    const getRandomValues = vi.fn(bytes => bytes.fill(getRandomValues.mock.calls.length === 1 ? 0 : 255));
    vi.stubGlobal('crypto', { getRandomValues });

    expect(createOperationId()).toBe('00000000-0000-4000-8000-000000000000');
    expect(createOperationId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(getRandomValues.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    expect(getRandomValues.mock.calls[0][0]).not.toBe(getRandomValues.mock.calls[1][0]);
  });

  it('does not substitute insecure randomness if browser cryptography is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => createOperationId()).toThrow('Secure random generation is unavailable');
  });
});
