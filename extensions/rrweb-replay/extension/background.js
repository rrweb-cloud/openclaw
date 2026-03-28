chrome.runtime.onInstalled.addListener(() => {
  const sessionStore = chrome.storage && chrome.storage.session;
  if (!sessionStore || typeof sessionStore.set !== "function") {
    return;
  }
  void sessionStore.set({ openclawRrwebBootstrapInstalled: true }).catch(() => {});
});
