import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printQueueVisible, watchPrintQueue } from './printQueueRefresh';

let page, element, collapsed, hidden, connected;
beforeEach(() => {
  vi.useFakeTimers();
  page = new EventTarget(); page.visibilityState = 'visible';
  collapsed = false; hidden = false; connected = true;
  element = {
    get isConnected() { return connected; },
    closest: () => collapsed || hidden ? {} : null,
  };
});
afterEach(() => vi.useRealTimers());
const toggle = () => page.dispatchEvent(new Event('toggle'));
const visibility = value => { page.visibilityState = value; page.dispatchEvent(new Event('visibilitychange')); };

describe('print confirmation refresh lifecycle', () => {
  it('keeps a mounted queue quiet inside a closed ancestor and checks remotely only when opened', async () => {
    collapsed = true;
    const refresh = vi.fn();
    const stop = watchPrintQueue({element, page, refresh, onError: vi.fn()});
    await vi.advanceTimersByTimeAsync(86400000);
    expect(refresh).not.toHaveBeenCalled();
    collapsed = false; toggle();
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0][0]).toBe(true);
    await vi.advanceTimersByTimeAsync(45000);
    expect(refresh.mock.calls.map(call => call[0])).toEqual([true, false, false, false]);
    collapsed = true; toggle();
    await vi.advanceTimersByTimeAsync(86400000);
    expect(refresh).toHaveBeenCalledTimes(4);
    stop();
  });

  it('stops hidden-tab reads and resumes with one remote read rather than replaying missed ticks', async () => {
    const refresh = vi.fn();
    const stop = watchPrintQueue({element, page, refresh, onError: vi.fn()});
    await Promise.resolve();
    visibility('hidden');
    await vi.advanceTimersByTimeAsync(86400000);
    expect(refresh).toHaveBeenCalledOnce();
    visibility('visible');
    expect(refresh.mock.calls.map(call => call[0])).toEqual([true, true]);
    // Opening a child disclosure does not count as reopening this queue.
    toggle(); toggle();
    await vi.advanceTimersByTimeAsync(15000);
    expect(refresh.mock.calls.map(call => call[0])).toEqual([true, true, false]);
    stop();
  });

  it('never overlaps a slow refresh and coalesces reopening while it is in flight', async () => {
    let release;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stop = watchPrintQueue({element, page, refresh, onError: vi.fn()});
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledOnce();
    collapsed = true; toggle(); collapsed = false; toggle();
    collapsed = true; toggle(); collapsed = false; toggle();
    expect(refresh).toHaveBeenCalledOnce();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(refresh.mock.calls.map(call => call[0])).toEqual([true, true]);
    stop();
  });

  it('stops a mounted queue when its Batches view is hidden and refreshes once when shown again', async () => {
    const section = {};
    element.parentElement = section;
    let changed;
    const observe = vi.fn(), disconnect = vi.fn();
    page.defaultView = {MutationObserver: class {
      constructor(callback) { changed = callback; }
      observe = observe;
      disconnect = disconnect;
    }};
    const refresh = vi.fn();
    const stop = watchPrintQueue({element,page,refresh,onError:vi.fn()});
    expect(observe.mock.calls.map(([node]) => node)).toEqual([element,section]);
    expect(observe.mock.calls.every(([,options]) => options.attributeFilter.join() === 'hidden')).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(refresh.mock.calls.map(call => call[0])).toEqual([true,false]);
    // Prepare another batch hides the existing Batches section; it does not unmount.
    hidden = true; changed();
    expect(printQueueVisible(element,page)).toBe(false);
    await vi.advanceTimersByTimeAsync(86400000);
    visibility('hidden'); visibility('visible');
    expect(refresh).toHaveBeenCalledTimes(2);
    hidden = false; changed();
    await vi.advanceTimersByTimeAsync(15000);
    expect(refresh.mock.calls.map(call => call[0])).toEqual([true,false,true,false]);
    stop();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('suppresses late errors and queued reads after cleanup', async () => {
    let reject;
    const refresh = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onError = vi.fn();
    const stop = watchPrintQueue({element, page, refresh, onError});
    const isCurrent = refresh.mock.calls[0][1];
    stop();
    expect(isCurrent()).toBe(false);
    reject(new Error('Late result')); await vi.advanceTimersByTimeAsync(30000);
    toggle(); visibility('visible');
    expect(onError).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledOnce();
  });

  it('considers detached elements and closed disclosures inactive', () => {
    expect(printQueueVisible(element, page)).toBe(true);
    connected = false; expect(printQueueVisible(element, page)).toBe(false);
    connected = true; collapsed = true; expect(printQueueVisible(element, page)).toBe(false);
  });
});
