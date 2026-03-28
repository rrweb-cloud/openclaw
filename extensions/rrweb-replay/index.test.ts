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
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
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

  it("enables replay with only a public key configured", async () => {
    type RegisteredTool = {
      execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    };

    const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrweb-replay-plugin-ext-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrweb-replay-plugin-state-"));
    let registeredToolFactory:
      | ((ctx: { sessionKey?: string; sessionId?: string }) => RegisteredTool | null | undefined)
      | undefined;

    entry.register(
      createTestPluginApi({
        id: "rrweb-replay",
        name: "rrweb-replay",
        source: "test",
        config: {
          browser: {
            profiles: {
              openclaw: {
                cdpPort: 18800,
              },
            },
          },
        } as never,
        pluginConfig: {
          enabled: true,
          publicKey: "pk_test_123",
          extensionMode: "external-path",
          extensionPath: extensionDir,
          browserProfiles: ["openclaw"],
        },
        runtime: {
          state: {
            resolveStateDir: () => stateDir,
          },
        } as never,
        rootDir: extensionDir,
        registerTool(tool: Parameters<typeof createTestPluginApi>[0]["registerTool"]) {
          registeredToolFactory = typeof tool === "function" ? (tool as never) : () => tool;
        },
      }),
    );

    const tool = registeredToolFactory?.({
      sessionKey: "session-key-1",
      sessionId: "session-id-1",
    }) as RegisteredTool | undefined;
    const result = (await tool?.execute?.("tool-1", {})) as
      | { details?: Record<string, unknown> }
      | undefined;

    expect(result?.details).toMatchObject({
      ok: true,
      enabled: true,
      compatibilityMode: "modern",
      replayServerUrl: "https://api.rrwebcloud.com",
    });
  });

  it("registers and unregisters the managed browser extension on modern hosts", async () => {
    const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrweb-replay-service-ext-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrweb-replay-service-state-"));
    let registeredService:
      | {
          start: (ctx: {
            logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
          }) => Promise<void>;
          stop: () => Promise<void>;
        }
      | undefined;

    entry.register(
      createTestPluginApi({
        id: "rrweb-replay",
        name: "rrweb-replay",
        source: "test",
        config: {
          browser: {
            profiles: {
              openclaw: {
                cdpPort: 18800,
              },
            },
          },
        } as never,
        pluginConfig: {
          enabled: true,
          publicKey: "pk_test_123",
          extensionMode: "external-path",
          extensionPath: extensionDir,
          browserProfiles: ["openclaw"],
        },
        runtime: {
          state: {
            resolveStateDir: () => stateDir,
          },
        } as never,
        rootDir: extensionDir,
        registerService(service) {
          registeredService = service as never;
        },
      }),
    );

    expect(registeredService).toBeTruthy();
    await registeredService?.start({
      logger: { info() {}, warn() {} },
    });

    expect(
      resolveManagedBrowserExtensionPaths({
        profileName: "openclaw",
      }),
    ).toContain(path.resolve(extensionDir));

    await registeredService?.stop();

    expect(
      resolveManagedBrowserExtensionPaths({
        profileName: "openclaw",
      }),
    ).not.toContain(path.resolve(extensionDir));
  });
});
