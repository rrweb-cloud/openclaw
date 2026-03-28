import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeConfigFile: vi.fn(),
  enablePluginInConfig: vi.fn(),
  recordPluginInstall: vi.fn(),
  applySlotSelectionForPlugin: vi.fn(),
  logSlotWarnings: vi.fn(),
  defaultRuntimeLog: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: mocks.enablePluginInConfig,
}));

vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall: mocks.recordPluginInstall,
}));

vi.mock("./plugins-command-helpers.js", () => ({
  applySlotSelectionForPlugin: mocks.applySlotSelectionForPlugin,
  enableInternalHookEntries: vi.fn(),
  logHookPackRestartHint: vi.fn(),
  logSlotWarnings: mocks.logSlotWarnings,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: mocks.defaultRuntimeLog,
  },
}));

vi.mock("../terminal/theme.js", () => ({
  theme: {
    warn: (value: string) => value,
  },
}));

import { persistPluginInstall } from "./plugins-install-persist.js";

describe("persistPluginInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enablePluginInConfig.mockReturnValue({ config: {} });
    mocks.recordPluginInstall.mockImplementation((config) => config);
    mocks.applySlotSelectionForPlugin.mockImplementation((config) => ({
      config,
      warnings: [],
    }));
  });

  it("logs rrweb replay post-install config guidance", async () => {
    await persistPluginInstall({
      config: {},
      pluginId: "rrweb-replay",
      install: {
        source: "npm",
        spec: "@rrwebcloud/openclaw-session-recording",
        installPath: "/tmp/rrweb-replay",
      },
    });

    expect(mocks.defaultRuntimeLog).toHaveBeenCalledWith(
      "Next step: add your rrweb public key to OpenClaw config.",
    );
    expect(mocks.defaultRuntimeLog).toHaveBeenCalledWith(
      "      publicKey: pk_live_your_public_key",
    );
    expect(mocks.defaultRuntimeLog).toHaveBeenCalledWith(
      "serverUrl already defaults to https://api.rrwebcloud.com.",
    );
  });
});
