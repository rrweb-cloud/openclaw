import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { closePlaywrightBrowserConnection, listPagesViaPlaywright } from "./pw-session.js";
import {
  clearManagedBrowserReplayContext,
  setManagedBrowserReplayContext,
} from "./runtime-registry.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

type BrowserMockBundle = {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
  contextAddInitScript: ReturnType<typeof vi.fn>;
  pageEvaluate: ReturnType<typeof vi.fn>;
};

function makeBrowser(targetId: string, url: string): BrowserMockBundle {
  let context: import("playwright-core").BrowserContext;
  const browserClose = vi.fn(async () => {});
  const pageEvaluate = vi.fn(async () => {});
  const page = {
    on: vi.fn(),
    context: () => context,
    title: vi.fn(async () => `title:${targetId}`),
    url: vi.fn(() => url),
    evaluate: pageEvaluate,
  } as unknown as import("playwright-core").Page;

  const contextAddInitScript = vi.fn(async () => {});
  context = {
    pages: () => [page],
    on: vi.fn(),
    addInitScript: contextAddInitScript,
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { targetId } } : {},
      ),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, contextAddInitScript, pageEvaluate };
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketUrlSpy.mockReset();
  clearManagedBrowserReplayContext("http://127.0.0.1:9222");
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session connection scoping", () => {
  it("does not share in-flight connectOverCDP promises across different cdpUrls", async () => {
    const browserA = makeBrowser("A", "https://a.example");
    const browserB = makeBrowser("B", "https://b.example");
    let resolveA: ((value: import("playwright-core").Browser) => void) | undefined;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === "http://127.0.0.1:9222") {
        return await new Promise<import("playwright-core").Browser>((resolve) => {
          resolveA = resolve;
        });
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const pendingA = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await Promise.resolve();
    const pendingB = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    await vi.waitFor(() => {
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    });
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:9222",
      expect.any(Object),
    );
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:9333",
      expect.any(Object),
    );

    resolveA?.(browserA.browser);
    const [pagesA, pagesB] = await Promise.all([pendingA, pendingB]);
    expect(pagesA.map((page) => page.targetId)).toEqual(["A"]);
    expect(pagesB.map((page) => page.targetId)).toEqual(["B"]);
  });

  it("closes only the requested scoped connection", async () => {
    const browserA = makeBrowser("A", "https://a.example");
    const browserB = makeBrowser("B", "https://b.example");

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === "http://127.0.0.1:9222") {
        return browserA.browser;
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    await closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" });

    expect(browserA.browserClose).toHaveBeenCalledTimes(1);
    expect(browserB.browserClose).not.toHaveBeenCalled();
  });

  it("applies managed replay context to existing browser contexts on connect", async () => {
    const browser = makeBrowser("A", "https://a.example");

    setManagedBrowserReplayContext({
      cdpUrl: "http://127.0.0.1:9222/",
      profile: "openclaw",
      sessionKey: "session-key-1",
      replaySessionId: "replay-session-1",
      replayUrl: "https://replay.example/session-1",
      replayServerUrl: "https://api.rrwebcloud.com",
      updatedAt: "2026-03-28T13:00:00.000Z",
    });

    connectOverCdpSpy.mockResolvedValue(browser.browser as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    expect(browser.contextAddInitScript).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        replaySessionId: "replay-session-1",
        replayUrl: "https://replay.example/session-1",
        replayServerUrl: "https://api.rrwebcloud.com",
        sessionKey: "session-key-1",
        profile: "openclaw",
      }),
    );
    expect(browser.pageEvaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        replaySessionId: "replay-session-1",
        replayUrl: "https://replay.example/session-1",
        sessionKey: "session-key-1",
      }),
    );
  });
});
