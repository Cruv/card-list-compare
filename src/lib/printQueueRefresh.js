// Collapsed disclosures and inactive view sections keep their children mounted.
export function printQueueVisible(element, page = document) {
  return !!element?.isConnected && page.visibilityState === 'visible'
    && !element.closest('details:not([open]), [hidden]');
}

/** Remote reads happen on opening/resuming. Timer ticks read only CLC's ledger. */
export function watchPrintQueue({ element, refresh, onError, page = document, interval = 15000 }) {
  let disposed = false;
  let visible = false;
  let timer;
  let running = false;
  let remoteQueued = false;
  const current = () => !disposed && printQueueVisible(element, page);
  const run = async remote => {
    if (!current()) return;
    if (running) {
      remoteQueued ||= remote;
      return;
    }
    running = true;
    try { await refresh(remote, current); }
    catch (error) { if (current()) onError(error); }
    finally {
      running = false;
      if (remoteQueued && current()) {
        remoteQueued = false;
        void run(true);
      }
    }
  };
  const update = () => {
    const next = current();
    if (next === visible) return;
    visible = next;
    clearInterval(timer);
    if (visible) {
      void run(true);
      timer = setInterval(() => { void run(false); }, interval);
    } else remoteQueued = false;
  };
  // Native toggle does not bubble, so observe disclosure ancestors in capture.
  page.addEventListener('toggle', update, true);
  page.addEventListener('visibilitychange', update);
  // Switching PrintPanel views changes an ancestor's hidden attribute without
  // unmounting this queue or producing a disclosure/visibility event.
  const Observer = page.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(update) : null;
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    observer?.observe(ancestor, {attributes:true,attributeFilter:['hidden']});
  }
  update();
  return () => {
    disposed = true;
    clearInterval(timer);
    page.removeEventListener('toggle', update, true);
    page.removeEventListener('visibilitychange', update);
    observer?.disconnect();
  };
}
