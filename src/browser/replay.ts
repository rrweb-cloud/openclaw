import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { STATE_DIR } from "../config/paths.js";
import { getLatestRunIdForSessionKey } from "../infra/agent-events.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const OPENCLAW_RRWEB_BOOTSTRAP_WINDOW_KEY = "__OPENCLAW_RRWEB_BOOTSTRAP__";
export const OPENCLAW_RRWEB_SESSION_WINDOW_KEY = "__OPENCLAW_RRWEB_SESSION__";
const TRACE_CONTEXT_REGISTRY_KEY = Symbol.for("openclaw.diagnostics-otel.trace-headers");
const REPLAY_STATE_KEY = Symbol.for("openclaw.browser.replay.state");
const REPLAY_STORE_PATH = path.join(STATE_DIR, "browser", "replay-mappings.json");
const REPLAY_PROVIDER = "rrwebcloud";

export type BrowserReplayRequestContext = {
  sessionKey?: string;
  runId?: string;
  agentId?: string;
  traceparent?: string;
  tracestate?: string;
};

export type BrowserReplayBootstrap = {
  provider: "rrwebcloud";
  sessionKey: string;
  runId?: string;
  agentId?: string;
  traceparent?: string;
  tracestate?: string;
};

export type BrowserReplaySessionMetadata = {
  sessionId?: string;
  url?: string;
  provider?: string;
  traceId?: string;
};

export type BrowserReplayMapping = {
  provider: string;
  sessionKey: string;
  runId?: string;
  agentId?: string;
  replaySessionId: string;
  replayUrl?: string;
  traceId?: string;
  traceparent?: string;
  tracestate?: string;
  createdAt: string;
  updatedAt: string;
};

type ReplayStoreFile = {
  version: 1;
  entriesBySessionKey: Record<string, BrowserReplayMapping>;
};

type ReplayState = {
  targetContexts: Map<string, BrowserReplayBootstrap>;
  mappingsBySessionKey: Map<string, BrowserReplayMapping>;
  loaded: boolean;
  persistPromise: Promise<void> | null;
};

const state = resolveGlobalSingleton<ReplayState>(REPLAY_STATE_KEY, () => ({
  targetContexts: new Map(),
  mappingsBySessionKey: new Map(),
  loaded: false,
  persistPromise: null,
}));

function normalizeSessionKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTargetKey(profileName: string, targetId: string) {
  return `${profileName.trim()}::${targetId.trim()}`;
}

function parseTraceIdFromTraceparent(traceparent?: string) {
  const value = traceparent?.trim();
  if (!value) {
    return undefined;
  }
  const parts = value.split("-");
  const traceId = parts[1]?.trim();
  return traceId && /^[0-9a-f]{32}$/i.test(traceId) ? traceId.toLowerCase() : undefined;
}

function getTraceHeaders(
  sessionKey: string,
): { traceparent: string; tracestate?: string } | undefined {
  const registry = (
    globalThis as {
      [TRACE_CONTEXT_REGISTRY_KEY]?: Map<string, { traceparent: string; tracestate?: string }>;
    }
  )[TRACE_CONTEXT_REGISTRY_KEY];
  return registry?.get(sessionKey);
}

async function ensureReplayStoreLoaded() {
  if (state.loaded) {
    return;
  }
  state.loaded = true;
  try {
    const raw = await fs.promises.readFile(REPLAY_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as ReplayStoreFile;
    for (const [sessionKey, mapping] of Object.entries(parsed.entriesBySessionKey ?? {})) {
      if (mapping?.replaySessionId && mapping?.sessionKey) {
        state.mappingsBySessionKey.set(sessionKey, mapping);
      }
    }
  } catch {
    // ignore missing/invalid state; start fresh
  }
}

function scheduleReplayStorePersist() {
  if (state.persistPromise) {
    return state.persistPromise;
  }
  state.persistPromise = (async () => {
    const entriesBySessionKey = Object.fromEntries(state.mappingsBySessionKey.entries());
    await writeJsonAtomic(
      REPLAY_STORE_PATH,
      { version: 1, entriesBySessionKey } satisfies ReplayStoreFile,
      { trailingNewline: true },
    );
  })().finally(() => {
    state.persistPromise = null;
  });
  return state.persistPromise;
}

export async function getReplayMappingForSessionKey(
  sessionKey: string | undefined,
): Promise<BrowserReplayMapping | null> {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) {
    return null;
  }
  await ensureReplayStoreLoaded();
  return state.mappingsBySessionKey.get(normalized) ?? null;
}

export function getReplayMappingForSessionKeySync(sessionKey: string | undefined) {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) {
    return null;
  }
  return state.mappingsBySessionKey.get(normalized) ?? null;
}

export async function upsertReplayMapping(params: {
  sessionKey: string;
  replaySessionId: string;
  replayUrl?: string;
  provider?: string;
  runId?: string;
  agentId?: string;
  traceparent?: string;
  tracestate?: string;
  traceId?: string;
}) {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  const replaySessionId = params.replaySessionId.trim();
  if (!sessionKey || !replaySessionId) {
    return null;
  }
  await ensureReplayStoreLoaded();
  const now = new Date().toISOString();
  const current = state.mappingsBySessionKey.get(sessionKey);
  const next: BrowserReplayMapping = {
    provider: params.provider?.trim() || current?.provider || REPLAY_PROVIDER,
    sessionKey,
    replaySessionId,
    runId: params.runId?.trim() || current?.runId,
    agentId: params.agentId?.trim() || current?.agentId,
    replayUrl: params.replayUrl?.trim() || current?.replayUrl,
    traceId:
      params.traceId?.trim() || parseTraceIdFromTraceparent(params.traceparent) || current?.traceId,
    traceparent: params.traceparent?.trim() || current?.traceparent,
    tracestate: params.tracestate?.trim() || current?.tracestate,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };
  state.mappingsBySessionKey.set(sessionKey, next);
  await scheduleReplayStorePersist();
  return next;
}

export function resolveBrowserReplayRequestContext(
  sessionKey: string | undefined,
): BrowserReplayRequestContext | null {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return null;
  }
  const headers = getTraceHeaders(normalizedSessionKey);
  const runId = getLatestRunIdForSessionKey(normalizedSessionKey);
  return {
    sessionKey: normalizedSessionKey,
    runId: runId ?? undefined,
    agentId: resolveAgentIdFromSessionKey(normalizedSessionKey) || undefined,
    traceparent: headers?.traceparent,
    tracestate: headers?.tracestate,
  };
}

export function buildBrowserReplayBootstrap(
  input: BrowserReplayRequestContext | null | undefined,
): BrowserReplayBootstrap | null {
  const sessionKey = normalizeSessionKey(input?.sessionKey);
  if (!sessionKey) {
    return null;
  }
  return {
    provider: REPLAY_PROVIDER,
    sessionKey,
    runId: input?.runId?.trim() || undefined,
    agentId: input?.agentId?.trim() || resolveAgentIdFromSessionKey(sessionKey) || undefined,
    traceparent: input?.traceparent?.trim() || undefined,
    tracestate: input?.tracestate?.trim() || undefined,
  };
}

export function registerReplayContextForTarget(params: {
  profileName: string;
  targetId: string;
  context: BrowserReplayRequestContext | BrowserReplayBootstrap | null | undefined;
}) {
  const bootstrap = buildBrowserReplayBootstrap(params.context);
  const key = normalizeTargetKey(params.profileName, params.targetId);
  if (!bootstrap) {
    state.targetContexts.delete(key);
    return null;
  }
  state.targetContexts.set(key, bootstrap);
  return bootstrap;
}

export function getReplayContextForTarget(params: { profileName: string; targetId: string }) {
  return state.targetContexts.get(normalizeTargetKey(params.profileName, params.targetId)) ?? null;
}

export async function applyReplayBootstrapToPage(params: {
  page: Page;
  bootstrap: BrowserReplayBootstrap;
}) {
  const payload = params.bootstrap;
  await params.page.addInitScript(
    ({ key, value }) => {
      const target = window as typeof window & Record<string, unknown>;
      target[key] = value;
    },
    { key: OPENCLAW_RRWEB_BOOTSTRAP_WINDOW_KEY, value: payload },
  );
  await params.page
    .evaluate(
      ({ key, value }) => {
        const target = window as typeof window & Record<string, unknown>;
        target[key] = value;
      },
      { key: OPENCLAW_RRWEB_BOOTSTRAP_WINDOW_KEY, value: payload },
    )
    .catch(() => undefined);
}

export async function collectReplaySessionMetadataFromPage(
  page: Page,
): Promise<BrowserReplaySessionMetadata | null> {
  const payload = await page
    .evaluate((key) => {
      const target = window as typeof window & Record<string, unknown>;
      const value = target[key];
      if (!value || typeof value !== "object") {
        return null;
      }
      const candidate = value as Record<string, unknown>;
      return {
        sessionId:
          typeof candidate.sessionId === "string"
            ? candidate.sessionId
            : typeof candidate.id === "string"
              ? candidate.id
              : undefined,
        url: typeof candidate.url === "string" ? candidate.url : undefined,
        provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
        traceId: typeof candidate.traceId === "string" ? candidate.traceId : undefined,
      };
    }, OPENCLAW_RRWEB_SESSION_WINDOW_KEY)
    .catch(() => null);
  if (!payload?.sessionId) {
    return null;
  }
  return payload;
}

export async function collectAndPersistReplaySession(params: {
  page: Page;
  profileName: string;
  targetId: string;
}) {
  const bootstrap = getReplayContextForTarget({
    profileName: params.profileName,
    targetId: params.targetId,
  });
  if (!bootstrap) {
    return null;
  }
  const metadata = await collectReplaySessionMetadataFromPage(params.page);
  if (!metadata?.sessionId) {
    return null;
  }
  return await upsertReplayMapping({
    sessionKey: bootstrap.sessionKey,
    replaySessionId: metadata.sessionId,
    replayUrl: metadata.url,
    provider: metadata.provider || bootstrap.provider,
    runId: bootstrap.runId,
    agentId: bootstrap.agentId,
    traceparent: bootstrap.traceparent,
    tracestate: bootstrap.tracestate,
    traceId: metadata.traceId,
  });
}
