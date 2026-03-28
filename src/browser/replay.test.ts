import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  OPENCLAW_RRWEB_BOOTSTRAP_WINDOW_KEY,
  applyReplayBootstrapToPage,
  buildBrowserReplayBootstrap,
  getReplayContextForTarget,
  registerReplayContextForTarget,
} from "./replay.js";

describe("browser replay helpers", () => {
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
});
