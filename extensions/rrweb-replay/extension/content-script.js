(function bootstrapOpenClawReplay() {
  const STATE_KEY = "openclawRrwebReplayContext";

  async function persist(detail) {
    if (!detail || typeof detail !== "object") {
      return;
    }
    const payload = {
      ...detail,
      href: window.location.href,
      capturedAt: new Date().toISOString(),
    };
    try {
      if (
        chrome.storage &&
        chrome.storage.session &&
        typeof chrome.storage.session.set === "function"
      ) {
        await chrome.storage.session.set({ [STATE_KEY]: payload });
      } else {
        throw new Error("session storage unavailable");
      }
    } catch {
      try {
        await chrome.storage.local.set({ [STATE_KEY]: payload });
      } catch {
        // ignore storage failures
      }
    }
    try {
      document.documentElement.dataset.openclawRrwebReplaySessionId =
        typeof payload.replaySessionId === "string" ? payload.replaySessionId : "";
    } catch {
      // ignore DOM updates
    }
  }

  const current = globalThis.__OPENCLAW_RRWEB_REPLAY;
  if (current) {
    void persist(current);
  }

  window.addEventListener("openclaw:rrweb-replay-context", (event) => {
    void persist(event && typeof event === "object" ? event.detail : undefined);
  });
})();
