import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrintStationStatus, sendPrintStationCommand, configurePrintStationDiscord, testPrintStationDiscord, findPrintStationCommand, previewPrintPlan, createPrintJob, preparePrintJobBacks, cancelPrintJobBacks } from './api';

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function abortableFetch(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

describe('print station HTTP requests', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'household-user-token'), removeItem: vi.fn() });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('selects one exact saved back packet without asserting the paper was already reloaded', async () => {
    fetch.mockResolvedValue(response(200, { station: {} }));
    const controller = new AbortController();
    await preparePrintJobBacks('batch-one', 'double-faced-002', controller.signal);
    await cancelPrintJobBacks('batch-one', controller.signal);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/print-station-management/jobs/batch-one/backs/prepare',
      '/api/print-station-management/jobs/batch-one/backs/cancel',
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ artifactId: 'double-faced-002' });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({});
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer household-user-token');
  });

  it('sends the exact paper-clearance boundary with a physical acknowledgement', async () => {
    fetch.mockResolvedValue(response(200, { command: { id: 'receipt' } }));
    const command = { idempotencyKey: 'stable-request', type: 'clear_paper', jobId: 'same-job',
      clearanceId: 'back:original-back-request', paperCleared: true };
    await sendPrintStationCommand(command);
    expect(fetch.mock.calls[0][0]).toBe('/api/print-station-management/commands');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(command);
  });

  it('uses secret-safe Discord endpoints and read-only recovery without writing browser storage', async () => {
    const persist = vi.fn();
    vi.stubGlobal('sessionStorage', { setItem: persist });
    const settings = { idempotencyKey: 'a2889ddd-4d34-4660-974b-3d89f87eff01', type: 'configure_discord', enabled: true,
      webhookUrl: 'https://discord.com/api/webhooks/123/fixture-secret', userId: '456' };
    fetch.mockResolvedValue(response(200, { command: { id: settings.idempotencyKey } }));
    await configurePrintStationDiscord(settings);
    await testPrintStationDiscord({ idempotencyKey: 'second-key', revision: settings.idempotencyKey });
    await findPrintStationCommand(settings.idempotencyKey);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/print-station-management/discord', '/api/print-station-management/discord/test',
      '/api/print-station-management/commands/' + settings.idempotencyKey,
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(settings);
    expect(fetch.mock.calls[1][1].body).not.toContain('fixture-secret');
    expect(fetch.mock.calls[2][1].body).toBeUndefined();
    for (const [, options] of fetch.mock.calls) expect(options.headers.Authorization).toBe('Bearer household-user-token');
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps Discord cancellation active through body parsing', async () => {
    const readingBody = vi.fn();
    fetch.mockImplementation(async (url, options) => ({ ok: true, status: 200,
      json: () => { readingBody(); return abortableFetch(url, options); } }));
    const controller = new AbortController();
    const rejected = expect(configurePrintStationDiscord({ idempotencyKey: 'fixture' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(readingBody).toHaveBeenCalled());
    controller.abort(); await rejected;
  });

  it('allows bounded card resolution time for preview and durable job creation', async () => {
    vi.useFakeTimers(); fetch.mockImplementation(abortableFetch);
    let failures = 0;
    const preview = previewPrintPlan(1, {}).catch(error => { failures++; throw error; });
    const creation = createPrintJob(1, {}).catch(error => { failures++; throw error; });
    const rejectedPreview = expect(preview).rejects.toThrow('Request timed out');
    const rejectedCreation = expect(creation).rejects.toThrow('Request timed out');
    await vi.advanceTimersByTimeAsync(89_999); expect(failures).toBe(0);
    await vi.advanceTimersByTimeAsync(1); await rejectedPreview; await rejectedCreation;
  });

  it('uses the signed-in user bearer token for station status', async () => {
    const status = { station: { online: false }, permissions: { canControl: true } };
    fetch.mockResolvedValue(response(200, status));
    expect(await getPrintStationStatus()).toEqual(status);
    expect(fetch).toHaveBeenCalledWith('/api/print-station-management/status', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer household-user-token' }),
      signal: expect.any(AbortSignal),
    }));
  });

  it('preserves 403 so the page can show restricted household access', async () => {
    fetch.mockResolvedValue(response(403, { error: 'Household access required' }));
    await expect(getPrintStationStatus()).rejects.toMatchObject({ status: 403, message: 'Household access required' });
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });

  it('uses the normal expired-session flow', async () => {
    fetch.mockResolvedValue(response(401, {}));
    await expect(getPrintStationStatus()).rejects.toThrow('Session expired');
    expect(localStorage.removeItem).toHaveBeenCalledWith('clc-auth-token');
    expect(window.dispatchEvent.mock.calls[0][0].type).toBe('auth-expired');
  });

  it('lets visibility/unmount cancellation abort the actual fetch without reporting a timeout', async () => {
    fetch.mockImplementation(abortableFetch);
    const controller = new AbortController();
    const result = getPrintStationStatus(controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('does not abort unrelated polling requests', async () => {
    fetch.mockImplementation(abortableFetch);
    const first = new AbortController();
    const second = new AbortController();
    const firstResult = expect(getPrintStationStatus(first.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const secondResult = expect(getPrintStationStatus(second.signal)).rejects.toMatchObject({ name: 'AbortError' });
    first.abort();
    await firstResult;
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
    second.abort();
    await secondResult;
  });

  it('keeps cancellation active while a response body is still arriving', async () => {
    const readingBody = vi.fn();
    fetch.mockImplementation(async (_url, options) => ({
      ok: true, status: 200,
      json: () => { readingBody(); return abortableFetch(_url, options); },
    }));
    const controller = new AbortController();
    const rejected = expect(getPrintStationStatus(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(readingBody).toHaveBeenCalled());
    controller.abort();
    await rejected;
  });

  it('still times out an unresponsive station status request', async () => {
    vi.useFakeTimers();
    fetch.mockImplementation(abortableFetch);
    const rejected = expect(getPrintStationStatus()).rejects.toThrow('Request timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });

  it('sends identical command keys and target versions when the same request is retried', async () => {
    const request = { idempotencyKey: 'a2889ddd-4d34-4660-974b-3d89f87eff01', type: 'update', targetVersion: '2.45.0' };
    fetch.mockRejectedValueOnce(new TypeError('Network request interrupted'));
    fetch.mockResolvedValueOnce(response(200, { command: { ...request, id: 'command-1', status: 'pending' } }));
    await expect(sendPrintStationCommand(request)).rejects.toThrow('Network error');
    await sendPrintStationCommand(request);
    expect(fetch.mock.calls.map(([url, options]) => [url, JSON.parse(options.body)])).toEqual([
      ['/api/print-station-management/commands', request],
      ['/api/print-station-management/commands', request],
    ]);
  });
});
