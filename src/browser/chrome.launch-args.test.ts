import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenClawChromeLaunchArgs } from "./chrome.js";
import {
  registerManagedBrowserExtensions,
  unregisterManagedBrowserExtensions,
} from "./runtime-registry.js";

describe("browser chrome launch args", () => {
  it("loads configured and runtime-managed extension paths", () => {
    registerManagedBrowserExtensions({
      sourceId: "test-runtime",
      profiles: ["openclaw"],
      extensionPaths: ["/tmp/runtime-extension"],
    });
    try {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: {
          enabled: true,
          controlPort: 18791,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18810,
          evaluateEnabled: false,
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          extraArgs: [],
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: false,
          ssrfPolicy: { allowPrivateNetwork: true },
          defaultProfile: "openclaw",
          profiles: {
            openclaw: { cdpPort: 18800, color: "#FF4500" },
          },
        },
        profile: {
          name: "openclaw",
          cdpUrl: "http://127.0.0.1:18800",
          cdpPort: 18800,
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          extensions: ["/tmp/config-extension"],
          color: "#FF4500",
          driver: "openclaw",
          attachOnly: false,
        },
        userDataDir: "/tmp/openclaw-test-user-data",
      });

      expect(args).toContain(
        "--disable-extensions-except=/tmp/config-extension,/tmp/runtime-extension",
      );
      expect(args).toContain("--load-extension=/tmp/config-extension,/tmp/runtime-extension");
    } finally {
      unregisterManagedBrowserExtensions("test-runtime");
    }
  });

  it("does not force an about:blank tab at startup", () => {
    const args = buildOpenClawChromeLaunchArgs({
      resolved: {
        enabled: true,
        controlPort: 18791,
        cdpProtocol: "http",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPortRangeStart: 18800,
        cdpPortRangeEnd: 18810,
        evaluateEnabled: false,
        remoteCdpTimeoutMs: 1500,
        remoteCdpHandshakeTimeoutMs: 3000,
        extraArgs: [],
        color: "#FF4500",
        headless: false,
        noSandbox: false,
        attachOnly: false,
        replay: {
          enabled: false,
          extensionPath: undefined,
          injectCorrelation: true,
          persistMappings: true,
        },
        ssrfPolicy: { allowPrivateNetwork: true },
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
        },
      },
      profile: {
        name: "openclaw",
        cdpUrl: "http://127.0.0.1:18800",
        cdpPort: 18800,
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        extensions: [],
        color: "#FF4500",
        driver: "openclaw",
        attachOnly: false,
      },
      userDataDir: "/tmp/openclaw-test-user-data",
    });

    expect(args).not.toContain("about:blank");
    expect(args).toContain("--remote-debugging-port=18800");
    expect(args).toContain("--user-data-dir=/tmp/openclaw-test-user-data");
  });

  it("loads the replay extension when configured", () => {
    const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-replay-args-"));
    try {
      const args = buildOpenClawChromeLaunchArgs({
        resolved: {
          enabled: true,
          controlPort: 18791,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18810,
          evaluateEnabled: false,
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          extraArgs: [],
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: false,
          replay: {
            enabled: true,
            extensionPath: extensionDir,
            injectCorrelation: true,
            persistMappings: true,
          },
          ssrfPolicy: { allowPrivateNetwork: true },
          defaultProfile: "openclaw",
          profiles: {
            openclaw: { cdpPort: 18800, color: "#FF4500" },
          },
        },
        profile: {
          name: "openclaw",
          cdpUrl: "http://127.0.0.1:18800",
          cdpPort: 18800,
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          color: "#FF4500",
          driver: "openclaw",
          attachOnly: false,
          extensions: [],
        },
        userDataDir: "/tmp/openclaw-test-user-data",
      });
      expect(args).toContain(`--disable-extensions-except=${extensionDir}`);
      expect(args).toContain(`--load-extension=${extensionDir}`);
    } finally {
      fs.rmSync(extensionDir, { recursive: true, force: true });
    }
  });
});
