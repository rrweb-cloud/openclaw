import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "../../src/browser/config.js";
import {
  clearManagedBrowserReplayContext,
  registerManagedBrowserExtensions,
  resolveManagedBrowserExtensionPaths,
  unregisterManagedBrowserExtensions,
} from "../../src/browser/runtime-registry.js";
import entry from "./index.js";

describe("rrweb replay browser integration", () => {
  beforeEach(() => {
    unregisterManagedBrowserExtensions("test");
    clearManagedBrowserReplayContext("http://127.0.0.1:18800");
  });

  it("merges runtime-managed extension paths into managed browser profiles", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrweb-replay-ext-"));
    registerManagedBrowserExtensions({
      sourceId: "test",
      profiles: ["openclaw"],
      extensionPaths: [tempDir],
    });
    const resolved = resolveBrowserConfig({
      profiles: {
        openclaw: {
          cdpPort: 18800,
          color: "#FF4500",
        },
      },
    });
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile).toBeTruthy();
    expect(
      resolveManagedBrowserExtensionPaths({
        profileName: "openclaw",
        configuredExtensions: profile?.extensions,
      }),
    ).toContain(path.resolve(tempDir));
  });

  it("registers replay_session_info as an optional tool", () => {
    const registerTool = vi.fn();
    entry.register({
      id: "rrweb-replay",
      name: "rrweb-replay",
      source: "test",
      registrationMode: "full",
      config: {},
      pluginConfig: {},
      runtime: {
        state: {
          resolveStateDir: () => os.tmpdir(),
        },
      },
      logger: { info() {}, warn() {}, error() {} },
      registerTool,
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerSpeechProvider() {},
      registerMediaUnderstandingProvider() {},
      registerImageGenerationProvider() {},
      registerWebSearchProvider() {},
      registerInteractiveHandler() {},
      onConversationBindingResolved() {},
      registerCommand() {},
      registerContextEngine() {},
      registerMemoryPromptSection() {},
      resolvePath(input: string) {
        return input;
      },
      on() {},
    } as never);
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "replay_session_info",
      optional: true,
    });
  });
});
