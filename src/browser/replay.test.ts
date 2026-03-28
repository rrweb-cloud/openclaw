import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENCLAW_RRWEB_BOOTSTRAP_WINDOW_KEY,
  applyReplayBootstrapToPage,
  buildBrowserReplayBootstrap,
  collectAndPersistReplaySession,
  ensureReplayCaptureForPage,
  getReplayContextForTarget,
  registerReplayContextForTarget,
} from "./replay.js";

describe("browser replay helpers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds a replay bootstrap only when a session key is present", () => {
    expect(
      buildBrowserReplayBootstrap({
        sessionKey: "session-key-1",
        runId: "run-1",
        agentId: "agent-1",
      }),
    ).toMatchObject({
      provider: "rrwebcloud",
      sessionKey: "session-key-1",
      runId: "run-1",
      agentId: "agent-1",
    });
    expect(buildBrowserReplayBootstrap({ runId: "run-1" })).toBeNull();
  });

  it("tracks replay context by profile and target id", () => {
    registerReplayContextForTarget({
      profileName: "openclaw",
      targetId: "target-1",
      context: {
        sessionKey: "session-key-1",
        runId: "run-1",
      },
    });

    expect(
      getReplayContextForTarget({
        profileName: "openclaw",
        targetId: "target-1",
      }),
    ).toMatchObject({
      provider: "rrwebcloud",
      sessionKey: "session-key-1",
      runId: "run-1",
    });
  });

  it("applies replay bootstrap payloads to pages", async () => {
    const addInitScript = vi.fn(async () => {});
    const evaluate = vi.fn(async () => {});
    const page = {
      addInitScript,
      evaluate,
    } as unknown as Page;

    await applyReplayBootstrapToPage({
      page,
      bootstrap: {
        provider: "rrwebcloud",
        sessionKey: "session-key-1",
        runId: "run-1",
      },
    });

    expect(addInitScript).toHaveBeenCalledWith(expect.any(Function), {
      key: OPENCLAW_RRWEB_BOOTSTRAP_WINDOW_KEY,
      value: {
        provider: "rrwebcloud",
        sessionKey: "session-key-1",
        runId: "run-1",
      },
    });
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      key: OPENCLAW_RRWEB_BOOTSTRAP_WINDOW_KEY,
      value: {
        provider: "rrwebcloud",
        sessionKey: "session-key-1",
        runId: "run-1",
      },
    });
  });

  it("captures rrweb events and uploads NDJSON to rrwebcloud", async () => {
    const sessionKey = `session-key-upload-${Date.now()}`;
    const bindings = new Map<string, (_source: unknown, event: unknown) => void>();
    const addInitScript = vi.fn(async () => {});
    const evaluate = vi.fn(async (fnOrScript: unknown, arg?: unknown) => {
      if (typeof fnOrScript === "function") {
        if (
          arg &&
          typeof arg === "object" &&
          "key" in (arg as Record<string, unknown>) &&
          (arg as { key?: string }).key === "__OPENCLAW_RRWEB_SESSION__"
        ) {
          return null;
        }
        return null;
      }
      return undefined;
    });
    const exposeBinding = vi.fn(
      async (name: string, callback: (_source: unknown, event: unknown) => void) => {
        bindings.set(name, callback);
      },
    );
    const page = {
      addInitScript,
      evaluate,
      exposeBinding,
    } as unknown as Page;

    globalThis.fetch = vi.fn(async () => {
      return new Response('{"successful_rows":2,"quarantined_rows":0}', { status: 202 });
    }) as unknown as typeof fetch;

    registerReplayContextForTarget({
      profileName: "openclaw",
      targetId: "target-upload",
      context: {
        sessionKey,
        runId: "run-upload",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
      uploadConfig: {
        publicKey: "public_key_rr_test",
        serverUrl: "https://api.rrwebcloud.com",
      },
    });

    await ensureReplayCaptureForPage({
      page,
      profileName: "openclaw",
      targetId: "target-upload",
    });

    const emit = [...bindings.values()][0];
    expect(emit).toBeTypeOf("function");
    emit?.(null, { type: 4, timestamp: 1, data: { href: "https://example.com" } });
    emit?.(null, { type: 2, timestamp: 2, data: { node: { id: 1, type: 0 } } });

    const mapping = await collectAndPersistReplaySession({
      page,
      profileName: "openclaw",
      targetId: "target-upload",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const urlText = typeof url === "string" ? url : url instanceof URL ? url.href : "";
    const bodyText =
      typeof (init as RequestInit).body === "string" ? (init as RequestInit).body : "";
    expect(urlText).toContain("/recordings/");
    expect(urlText).toContain("/ingest");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/x-ndjson",
        authorization: "Bearer public_key_rr_test",
      },
    });
    expect(bodyText).toContain('"tag":"recording-meta"');
    expect(bodyText).toContain(`"session_key":"${sessionKey}"`);
    expect(mapping).toMatchObject({
      sessionKey,
      provider: "rrwebcloud",
      replayUrl: expect.stringContaining("/preview"),
      traceId: "0123456789abcdef0123456789abcdef",
    });
    expect(exposeBinding).toHaveBeenCalledTimes(1);
    expect(addInitScript).toHaveBeenCalled();
  });
});
