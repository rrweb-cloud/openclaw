import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type AnyAgentTool, type OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

type RrwebReplayConfig = {
  enabled: boolean;
  serverUrl?: string;
  publicKey?: string;
  secretKey?: string;
  publicKeyEnvVar?: string;
  secretKeyEnvVar?: string;
  extensionMode: "bundled" | "external-path";
  extensionPath?: string;
  browserProfiles: string[];
  recordingPolicy: "browser-only" | "opt-in-tool";
};

type ReplaySessionState = {
  sessionKey?: string;
  sessionId?: string;
  replaySessionId: string;
  replayServerUrl?: string;
  replayUrl?: string;
  currentProfile?: string;
  currentCdpUrl?: string;
  recordingPolicy: RrwebReplayConfig["recordingPolicy"];
  status: "active" | "ended";
  reason?: string;
  updatedAt: string;
};

type ReplayStateStore = {
  sessions: Record<string, ReplaySessionState>;
};

const RRWEB_PLUGIN_ID = "rrweb-replay";
const DEFAULT_RRWEB_API_BASE_URL = "https://api.rrwebcloud.com";
const LEGACY_BROWSER_RUNTIME_REASON =
  "This OpenClaw host does not export plugin-sdk/browser-runtime. Automatic rrweb extension wiring requires OpenClaw >=2026.3.24. On legacy hosts, install/configure the rrweb browser addon separately or upgrade OpenClaw.";

type BrowserRuntimeCompat = {
  clearManagedBrowserReplayContextsForSession: (sessionKey: string) => void;
  registerManagedBrowserExtensions: (params: {
    sourceId: string;
    profiles: string[];
    extensionPaths: string[];
  }) => void;
  setManagedBrowserReplayContext: (params: {
    cdpUrl: string;
    profile: string;
    sessionKey?: string;
    sessionId?: string;
    replaySessionId: string;
    replayServerUrl?: string;
    replayUrl?: string;
    updatedAt: string;
  }) => void;
  unregisterManagedBrowserExtensions: (sourceId: string) => void;
};

const rrwebReplayConfigSchema = {
  parse(value: unknown): RrwebReplayConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const browserProfiles = Array.isArray(raw.browserProfiles)
      ? raw.browserProfiles
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    const extensionMode = raw.extensionMode === "external-path" ? "external-path" : "bundled";
    const recordingPolicy = raw.recordingPolicy === "opt-in-tool" ? "opt-in-tool" : "browser-only";
    const readOptional = (key: string) => {
      const value = raw[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    return {
      enabled: raw.enabled !== false,
      serverUrl: readOptional("serverUrl") ?? DEFAULT_RRWEB_API_BASE_URL,
      publicKey: readOptional("publicKey"),
      secretKey: readOptional("secretKey"),
      publicKeyEnvVar: readOptional("publicKeyEnvVar"),
      secretKeyEnvVar: readOptional("secretKeyEnvVar"),
      extensionMode,
      extensionPath: readOptional("extensionPath"),
      browserProfiles: browserProfiles.length > 0 ? browserProfiles : ["openclaw"],
      recordingPolicy,
    };
  },
  uiHints: {
    serverUrl: {
      label: "Replay Server URL",
      placeholder: DEFAULT_RRWEB_API_BASE_URL,
      advanced: true,
      help: "Optional. Defaults to the rrweb Cloud API endpoint used by the bundled browser replay flow.",
    },
    publicKey: { label: "Public Key", sensitive: true },
    secretKey: {
      label: "Secret Key",
      sensitive: true,
      advanced: true,
      help: "Optional. Reserved for future server-side upload flows and not required for the bundled browser bootstrap.",
    },
    publicKeyEnvVar: { label: "Public Key Env Var", advanced: true },
    secretKeyEnvVar: {
      label: "Secret Key Env Var",
      advanced: true,
      help: "Optional. Only needed when a future rrweb upload path requires a secret key.",
    },
    extensionMode: { label: "Extension Mode" },
    extensionPath: { label: "External Extension Path", advanced: true },
    browserProfiles: { label: "Browser Profiles" },
    recordingPolicy: { label: "Recording Policy" },
  },
};

function normalizeServerUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function jsonToolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

function resolveConfiguredSecret(params: {
  value?: string;
  envVarName?: string;
}): string | undefined {
  const direct = params.value?.trim();
  if (direct) {
    return direct;
  }
  const envVarName = params.envVarName?.trim();
  if (!envVarName) {
    return undefined;
  }
  const fromEnv = process.env[envVarName];
  return typeof fromEnv === "string" && fromEnv.trim() ? fromEnv.trim() : undefined;
}

function resolveExtensionDirectory(params: {
  config: RrwebReplayConfig;
  api: OpenClawPluginApi;
}): string | null {
  const rootDir = params.api.rootDir;
  if (!rootDir) {
    return null;
  }
  const extensionDir =
    params.config.extensionMode === "external-path"
      ? params.config.extensionPath
      : path.join(rootDir, "extension");
  const resolved =
    params.config.extensionMode === "external-path" && extensionDir
      ? params.api.resolvePath(extensionDir)
      : (extensionDir ?? "");
  if (!resolved || !fs.existsSync(resolved)) {
    return null;
  }
  return resolved;
}

function resolvePluginStateFile(api: OpenClawPluginApi): string {
  return path.join(
    api.runtime.state.resolveStateDir(),
    "plugins",
    RRWEB_PLUGIN_ID,
    "sessions.json",
  );
}

async function loadReplayState(api: OpenClawPluginApi): Promise<ReplayStateStore> {
  const filePath = resolvePluginStateFile(api);
  const { value } = await readJsonFileWithFallback<ReplayStateStore>(filePath, { sessions: {} });
  return value;
}

async function saveReplayState(api: OpenClawPluginApi, state: ReplayStateStore): Promise<void> {
  const filePath = resolvePluginStateFile(api);
  await writeJsonFileAtomically(filePath, state);
}

function buildReplaySessionState(params: {
  sessionKey?: string;
  sessionId?: string;
  config: RrwebReplayConfig;
  reason?: string;
  previous?: ReplaySessionState;
}): ReplaySessionState {
  const updatedAt = new Date().toISOString();
  const replaySessionId =
    params.sessionId?.trim() || params.previous?.replaySessionId || crypto.randomUUID();
  return {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    replaySessionId,
    replayServerUrl: normalizeServerUrl(params.config.serverUrl),
    replayUrl: params.previous?.replayUrl,
    currentProfile: params.previous?.currentProfile,
    currentCdpUrl: params.previous?.currentCdpUrl,
    recordingPolicy: params.config.recordingPolicy,
    status: "active",
    ...(params.reason ? { reason: params.reason } : {}),
    updatedAt,
  };
}

function describeReplayAvailability(params: {
  config: RrwebReplayConfig;
  extensionDir: string | null;
  browserRuntimeAvailable: boolean;
}): { enabled: boolean; reason?: string } {
  if (!params.config.enabled) {
    return { enabled: false, reason: "Plugin disabled in rrweb-replay config." };
  }
  if (!params.browserRuntimeAvailable) {
    return {
      enabled: false,
      reason: LEGACY_BROWSER_RUNTIME_REASON,
    };
  }
  if (!params.extensionDir) {
    return {
      enabled: false,
      reason: "Replay extension directory is missing. Check rrweb-replay.extensionMode/path.",
    };
  }
  const publicKey = resolveConfiguredSecret({
    value: params.config.publicKey,
    envVarName: params.config.publicKeyEnvVar,
  });
  if (!publicKey) {
    return {
      enabled: false,
      reason:
        "Replay public key is not configured. Set publicKey or publicKeyEnvVar. The API endpoint already defaults to rrweb Cloud, and secretKey is optional for the bundled browser bootstrap.",
    };
  }
  return { enabled: true };
}

async function loadBrowserRuntimeCompat(): Promise<BrowserRuntimeCompat | null> {
  try {
    const mod = (await import("openclaw/plugin-sdk/browser-runtime")) as BrowserRuntimeCompat;
    if (
      typeof mod.registerManagedBrowserExtensions === "function" &&
      typeof mod.unregisterManagedBrowserExtensions === "function" &&
      typeof mod.setManagedBrowserReplayContext === "function" &&
      typeof mod.clearManagedBrowserReplayContextsForSession === "function"
    ) {
      return mod;
    }
  } catch {
    // Legacy OpenClaw hosts do not expose plugin-sdk/browser-runtime.
  }
  return null;
}

function resolveBrowserProfileForReplay(params: {
  config: OpenClawConfig;
  preferredProfile?: string;
}): { name: string; cdpUrl?: string; driver?: string } | null {
  const browser = params.config.browser;
  const profiles =
    browser?.profiles && typeof browser.profiles === "object" ? browser.profiles : undefined;
  const profileName =
    params.preferredProfile?.trim() || browser?.defaultProfile?.trim() || "openclaw";
  const rawProfile =
    profiles && typeof profiles[profileName] === "object" && profiles[profileName] != null
      ? (profiles[profileName] as Record<string, unknown>)
      : null;
  if (!rawProfile) {
    return null;
  }
  const driver = typeof rawProfile.driver === "string" ? rawProfile.driver : undefined;
  if (driver === "existing-session") {
    return { name: profileName, driver };
  }
  const rawCdpUrl =
    typeof rawProfile.cdpUrl === "string" && rawProfile.cdpUrl.trim()
      ? rawProfile.cdpUrl.trim()
      : typeof browser?.cdpUrl === "string" && browser.cdpUrl.trim()
        ? browser.cdpUrl.trim()
        : undefined;
  if (rawCdpUrl) {
    return { name: profileName, cdpUrl: rawCdpUrl.replace(/\/+$/, ""), driver };
  }
  const cdpPort =
    typeof rawProfile.cdpPort === "number" && Number.isFinite(rawProfile.cdpPort)
      ? rawProfile.cdpPort
      : undefined;
  if (cdpPort) {
    return { name: profileName, cdpUrl: `http://127.0.0.1:${cdpPort}`, driver };
  }
  return { name: profileName, driver };
}

async function upsertReplaySession(params: {
  api: OpenClawPluginApi;
  config: RrwebReplayConfig;
  sessionKey?: string;
  sessionId?: string;
  mutate?: (entry: ReplaySessionState) => ReplaySessionState;
}): Promise<ReplaySessionState> {
  const state = await loadReplayState(params.api);
  const storeKey = params.sessionKey?.trim() || params.sessionId?.trim() || crypto.randomUUID();
  const previous = state.sessions[storeKey];
  const base = buildReplaySessionState({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    config: params.config,
    previous,
  });
  const next = params.mutate ? params.mutate(base) : base;
  state.sessions[storeKey] = next;
  await saveReplayState(params.api, state);
  return next;
}

async function getReplaySessionEntry(params: {
  api: OpenClawPluginApi;
  sessionKey?: string;
  sessionId?: string;
}): Promise<ReplaySessionState | null> {
  const state = await loadReplayState(params.api);
  const bySessionKey = params.sessionKey?.trim();
  if (bySessionKey && state.sessions[bySessionKey]) {
    return state.sessions[bySessionKey];
  }
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return null;
  }
  for (const entry of Object.values(state.sessions)) {
    if (entry.sessionId === sessionId) {
      return entry;
    }
  }
  return null;
}

async function markReplaySessionEnded(params: {
  api: OpenClawPluginApi;
  sessionKey?: string;
  sessionId?: string;
}): Promise<void> {
  const state = await loadReplayState(params.api);
  const storeKey = params.sessionKey?.trim();
  if (storeKey && state.sessions[storeKey]) {
    state.sessions[storeKey] = {
      ...state.sessions[storeKey],
      status: "ended",
      updatedAt: new Date().toISOString(),
    };
    await saveReplayState(params.api, state);
    return;
  }
  if (!params.sessionId?.trim()) {
    return;
  }
  for (const [key, entry] of Object.entries(state.sessions)) {
    if (entry.sessionId !== params.sessionId) {
      continue;
    }
    state.sessions[key] = {
      ...entry,
      status: "ended",
      updatedAt: new Date().toISOString(),
    };
    await saveReplayState(params.api, state);
    return;
  }
}

async function armReplayContext(params: {
  api: OpenClawPluginApi;
  pluginConfig: RrwebReplayConfig;
  browserRuntime: BrowserRuntimeCompat | null;
  sessionKey?: string;
  sessionId?: string;
  preferredProfile?: string;
}): Promise<ReplaySessionState> {
  const replayEntry =
    (await getReplaySessionEntry({
      api: params.api,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    })) ??
    (await upsertReplaySession({
      api: params.api,
      config: params.pluginConfig,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    }));
  const profile = resolveBrowserProfileForReplay({
    config: params.api.config,
    preferredProfile: params.preferredProfile ?? replayEntry.currentProfile,
  });
  if (!params.browserRuntime || !profile || !profile.cdpUrl) {
    return replayEntry;
  }
  params.browserRuntime.setManagedBrowserReplayContext({
    cdpUrl: profile.cdpUrl,
    profile: profile.name,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    replaySessionId: replayEntry.replaySessionId,
    replayServerUrl: replayEntry.replayServerUrl,
    replayUrl: replayEntry.replayUrl,
    updatedAt: new Date().toISOString(),
  });
  return await upsertReplaySession({
    api: params.api,
    config: params.pluginConfig,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    mutate: (entry) => ({
      ...entry,
      replaySessionId: replayEntry.replaySessionId,
      currentProfile: profile.name,
      currentCdpUrl: profile.cdpUrl,
      updatedAt: new Date().toISOString(),
    }),
  });
}

function createReplaySessionInfoTool(params: {
  api: OpenClawPluginApi;
  pluginConfig: RrwebReplayConfig;
  extensionDir: string | null;
  browserRuntimePromise: Promise<BrowserRuntimeCompat | null>;
  context: {
    sessionKey?: string;
    sessionId?: string;
  };
}): AnyAgentTool {
  return {
    name: "replay_session_info",
    label: "Replay Session Info",
    description:
      "Show the current rrweb replay session id, targeted browser profile, and replay readiness.",
    parameters: Type.Object({
      activate: Type.Optional(
        Type.Boolean({
          description:
            "When true, arm replay context for the current session/profile. Useful with recordingPolicy=opt-in-tool.",
        }),
      ),
      profile: Type.Optional(
        Type.String({
          description: "Optional browser profile override when activating replay context.",
        }),
      ),
    }),
    execute: async (_id, rawParams) => {
      const browserRuntime = await params.browserRuntimePromise;
      const toolParams =
        rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : null;
      const availability = describeReplayAvailability({
        config: params.pluginConfig,
        extensionDir: params.extensionDir,
        browserRuntimeAvailable: Boolean(browserRuntime),
      });
      const activate = toolParams?.activate === true;
      const preferredProfile = toolParams
        ? typeof toolParams.profile === "string" && toolParams.profile.trim()
          ? toolParams.profile.trim()
          : undefined
        : undefined;
      let entry =
        (await getReplaySessionEntry({
          api: params.api,
          sessionKey: params.context.sessionKey,
          sessionId: params.context.sessionId,
        })) ??
        (await upsertReplaySession({
          api: params.api,
          config: params.pluginConfig,
          sessionKey: params.context.sessionKey,
          sessionId: params.context.sessionId,
          mutate: (next) => ({
            ...next,
            ...(availability.reason ? { reason: availability.reason } : {}),
          }),
        }));

      if (activate && availability.enabled) {
        entry = await armReplayContext({
          api: params.api,
          pluginConfig: params.pluginConfig,
          browserRuntime,
          sessionKey: params.context.sessionKey,
          sessionId: params.context.sessionId,
          preferredProfile,
        });
      }

      return jsonToolResult({
        ok: true,
        replaySessionId: entry.replaySessionId,
        replayUrl: entry.replayUrl ?? null,
        replayServerUrl: entry.replayServerUrl ?? null,
        browserProfile: entry.currentProfile ?? preferredProfile ?? null,
        cdpUrl: entry.currentCdpUrl ?? null,
        recordingPolicy: entry.recordingPolicy,
        enabled: availability.enabled,
        reason: availability.reason ?? entry.reason ?? null,
        activated: activate && availability.enabled,
        compatibilityMode: browserRuntime ? "modern" : "legacy",
      });
    },
  };
}

export default definePluginEntry({
  id: RRWEB_PLUGIN_ID,
  name: "rrweb Replay",
  description: "Portable rrweb replay bootstrap for OpenClaw-managed browsers.",
  configSchema: rrwebReplayConfigSchema,
  register(api: OpenClawPluginApi) {
    const pluginConfig = rrwebReplayConfigSchema.parse(api.pluginConfig);
    const extensionDir = resolveExtensionDirectory({ config: pluginConfig, api });
    const serviceSourceId = `${RRWEB_PLUGIN_ID}:${api.source}`;
    const browserRuntimePromise = loadBrowserRuntimeCompat();

    api.registerService({
      id: "rrweb-replay-browser-extension",
      async start(ctx) {
        const browserRuntime = await browserRuntimePromise;
        if (!pluginConfig.enabled) {
          ctx.logger.info("[rrweb-replay] disabled; not registering browser extension");
          return;
        }
        if (!browserRuntime) {
          ctx.logger.warn(`[rrweb-replay] ${LEGACY_BROWSER_RUNTIME_REASON}`);
          return;
        }
        if (!extensionDir) {
          ctx.logger.warn(
            "[rrweb-replay] extension directory missing; replay browser extension was not registered",
          );
          return;
        }
        browserRuntime.registerManagedBrowserExtensions({
          sourceId: serviceSourceId,
          profiles: pluginConfig.browserProfiles,
          extensionPaths: [extensionDir],
        });
        ctx.logger.info(
          `[rrweb-replay] registered extension for profiles: ${pluginConfig.browserProfiles.join(", ")}`,
        );
      },
      async stop() {
        const browserRuntime = await browserRuntimePromise;
        browserRuntime?.unregisterManagedBrowserExtensions(serviceSourceId);
      },
    });

    api.on("session_start", async (event, ctx) => {
      const browserRuntime = await browserRuntimePromise;
      const availability = describeReplayAvailability({
        config: pluginConfig,
        extensionDir,
        browserRuntimeAvailable: Boolean(browserRuntime),
      });
      await upsertReplaySession({
        api,
        config: pluginConfig,
        sessionKey: ctx.sessionKey,
        sessionId: event.sessionId,
        mutate: (entry) => ({
          ...entry,
          ...(availability.reason ? { reason: availability.reason } : {}),
        }),
      });
    });

    api.on("before_reset", async (_event, ctx) => {
      const browserRuntime = await browserRuntimePromise;
      if (ctx.sessionKey && browserRuntime) {
        browserRuntime.clearManagedBrowserReplayContextsForSession(ctx.sessionKey);
      }
      await markReplaySessionEnded({
        api,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
      });
    });

    api.on("session_end", async (_event, ctx) => {
      const browserRuntime = await browserRuntimePromise;
      if (ctx.sessionKey && browserRuntime) {
        browserRuntime.clearManagedBrowserReplayContextsForSession(ctx.sessionKey);
      }
      await markReplaySessionEnded({
        api,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
      });
    });

    api.on("before_tool_call", async (event, ctx) => {
      const browserRuntime = await browserRuntimePromise;
      const availability = describeReplayAvailability({
        config: pluginConfig,
        extensionDir,
        browserRuntimeAvailable: Boolean(browserRuntime),
      });
      if (event.toolName !== "browser" || pluginConfig.recordingPolicy !== "browser-only") {
        return;
      }
      if (!availability.enabled) {
        return;
      }
      const rawProfile =
        typeof event.params.profile === "string" && event.params.profile.trim()
          ? event.params.profile.trim()
          : undefined;
      await armReplayContext({
        api,
        pluginConfig,
        browserRuntime,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        preferredProfile: rawProfile,
      });
    });

    api.registerTool(
      (context) =>
        createReplaySessionInfoTool({
          api,
          pluginConfig,
          extensionDir,
          browserRuntimePromise,
          context: {
            sessionKey: context.sessionKey,
            sessionId: context.sessionId,
          },
        }),
      { name: "replay_session_info", optional: true },
    );
  },
});
