/** Remove a completed password-reset link and keep the hash router in sync. */
export function clearPasswordResetUrl(browser = window) {
  const oldURL = browser.location.href;
  const oldHash = browser.location.hash;
  browser.history.replaceState(null, '', browser.location.pathname);
  // replaceState does not dispatch hashchange, unlike normal hash navigation.
  if (oldHash !== browser.location.hash) {
    browser.dispatchEvent(new browser.HashChangeEvent('hashchange', {
      oldURL, newURL: browser.location.href,
    }));
  }
}
