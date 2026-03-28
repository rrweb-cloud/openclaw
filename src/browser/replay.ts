import crypto from "node:crypto";
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
const DEFAULT_RRWEB_CDN_URL = "https://cdn.jsdelivr.net/npm/rrweb@latest/dist/rrweb.min.js";

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

type BrowserReplayUploadConfig = {
  serverUrl?: string;
  publicKey?: string;
  rrwebCdnUrl?: string;
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
  targetContexts: Map<
    string,
    {
      bootstrap: BrowserReplayBootstrap;
      uploadConfig?: BrowserReplayUploadConfig;
    }
  >;
  mappingsBySessionKey: Map<string, BrowserReplayMapping>;
  captureByTarget: Map<
    string,
    {
      recordingId: string;
      previewUrl?: string;
      installedPageIds: Set<number>;
      installPromisesByPageId: Map<number, Promise<void>>;
      events: Array<Record<string, unknown>>;
      uploadedCount: number;
      metadataUploaded: boolean;
      uploadConfig?: BrowserReplayUploadConfig;
    }
  >;
  loaded: boolean;
  persistPromise: Promise<void> | null;
};

type ReplayCaptureStateEntry =
  ReplayState["captureByTarget"] extends Map<string, infer T> ? T : never;

const state = resolveGlobalSingleton<ReplayState>(REPLAY_STATE_KEY, () => ({
  targetContexts: new Map(),
  mappingsBySessionKey: new Map(),
  captureByTarget: new Map(),
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
  uploadConfig?: BrowserReplayUploadConfig;
}) {
  const bootstrap = buildBrowserReplayBootstrap(params.context);
  const key = normalizeTargetKey(params.profileName, params.targetId);
  if (!bootstrap) {
    state.targetContexts.delete(key);
    state.captureByTarget.delete(key);
    return null;
  }
  state.targetContexts.set(key, {
    bootstrap,
    uploadConfig: params.uploadConfig,
  });
  return bootstrap;
}

export function getReplayContextForTarget(params: { profileName: string; targetId: string }) {
  return (
    state.targetContexts.get(normalizeTargetKey(params.profileName, params.targetId))?.bootstrap ??
    null
  );
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

function buildReplayPreviewUrl(serverUrl: string | undefined, recordingId: string) {
  const base = (serverUrl?.trim() || "https://api.rrwebcloud.com").replace(/\/+$/, "");
  return `${base}/recordings/${recordingId}/preview`;
}

function buildReplayIngestUrl(serverUrl: string | undefined, recordingId: string) {
  const base = (serverUrl?.trim() || "https://api.rrwebcloud.com").replace(/\/+$/, "");
  return `${base}/recordings/${recordingId}/ingest`;
}

function buildRrwebRecorderInitScript(params: { bindingName: string; rrwebCdnUrl: string }) {
  return `(() => {
    const bindingName = ${JSON.stringify(params.bindingName)};
    const rrwebCdnUrl = ${JSON.stringify(params.rrwebCdnUrl)};
    const ensureScript = () => new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-openclaw-rrweb="' + rrwebCdnUrl + '"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('rrweb script failed to load')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = rrwebCdnUrl;
      script.async = true;
      script.dataset.openclawRrweb = rrwebCdnUrl;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('rrweb script failed to load'));
      const parent = document.head || document.body || document.documentElement;
      if (!parent) {
        reject(new Error('No DOM parent available for rrweb script'));
        return;
      }
      parent.appendChild(script);
    });
    const install = async () => {
      if (window.__openclawRrwebRecorderStarted) {
        return;
      }
      if (!window.rrweb || !window.rrweb.record) {
        if (document.readyState === 'loading') {
          await new Promise((resolve) =>
            document.addEventListener('DOMContentLoaded', resolve, { once: true }),
          );
        }
        await ensureScript();
      }
      if (!window.rrweb || !window.rrweb.record) {
        throw new Error('rrweb recorder unavailable');
      }
      window.__openclawRrwebRecorderStop = window.rrweb.record({
        emit(event) {
          if (typeof window[bindingName] === 'function') {
            window[bindingName](event);
          }
        },
        recordCanvas: false,
        collectFonts: false,
      });
      window.__openclawRrwebRecorderStarted = true;
    };
    install().catch((error) => {
      window.__openclawRrwebRecorderError = String(error && error.message ? error.message : error);
    });
  })();`;
}

async function setReplaySessionMarkerOnPage(params: {
  page: Page;
  recordingId: string;
  previewUrl?: string;
  traceId?: string;
}) {
  const value = {
    sessionId: params.recordingId,
    url: params.previewUrl,
    provider: REPLAY_PROVIDER,
    traceId: params.traceId,
  };
  await params.page
    .evaluate(
      ({ key, nextValue }) => {
        const target = window as typeof window & Record<string, unknown>;
        target[key] = nextValue;
      },
      { key: OPENCLAW_RRWEB_SESSION_WINDOW_KEY, nextValue: value },
    )
    .catch(() => undefined);
}

async function ensureReplayRecorderOnPage(params: {
  page: Page;
  profileName: string;
  targetId: string;
}) {
  const key = normalizeTargetKey(params.profileName, params.targetId);
  const registered = state.targetContexts.get(key);
  if (!registered) {
    return null;
  }
  if (!registered.uploadConfig?.publicKey?.trim()) {
    return null;
  }
  await ensureReplayStoreLoaded();
  const existingMapping = state.mappingsBySessionKey.get(registered.bootstrap.sessionKey);
  let capture = state.captureByTarget.get(key);
  if (!capture) {
    const recordingId = existingMapping?.replaySessionId || crypto.randomUUID();
    capture = {
      recordingId,
      previewUrl:
        existingMapping?.replayUrl ||
        buildReplayPreviewUrl(registered.uploadConfig?.serverUrl, recordingId),
      installedPageIds: new Set(),
      installPromisesByPageId: new Map(),
      events: [],
      uploadedCount: 0,
      metadataUploaded: Boolean(existingMapping),
      uploadConfig: registered.uploadConfig,
    };
    state.captureByTarget.set(key, capture);
  } else if (registered.uploadConfig) {
    capture.uploadConfig = {
      ...capture.uploadConfig,
      ...registered.uploadConfig,
    };
    capture.previewUrl =
      capture.previewUrl ||
      buildReplayPreviewUrl(capture.uploadConfig?.serverUrl, capture.recordingId);
  }
  const id = idPage(params.page);
  if (capture.installedPageIds.has(id)) {
    return capture;
  }
  const existingInstall = capture.installPromisesByPageId.get(id);
  if (existingInstall) {
    await existingInstall;
    return capture;
  }
  const bindingName = `__openclawRrwebEmit_${capture.recordingId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const installPromise = (async () => {
    await params.page.exposeBinding(bindingName, (_source, event: unknown) => {
      if (event && typeof event === "object" && !Array.isArray(event)) {
        capture?.events.push(event as Record<string, unknown>);
      }
    });
    const initScript = buildRrwebRecorderInitScript({
      bindingName,
      rrwebCdnUrl: capture?.uploadConfig?.rrwebCdnUrl || DEFAULT_RRWEB_CDN_URL,
    });
    await params.page.addInitScript(initScript);
    await params.page.evaluate(initScript).catch(() => undefined);
    await setReplaySessionMarkerOnPage({
      page: params.page,
      recordingId: capture?.recordingId || "",
      previewUrl: capture?.previewUrl,
      traceId: parseTraceIdFromTraceparent(registered.bootstrap.traceparent),
    });
    capture?.installedPageIds.add(id);
  })().finally(() => {
    capture?.installPromisesByPageId.delete(id);
  });
  capture.installPromisesByPageId.set(id, installPromise);
  await installPromise;
  return capture;
}

let nextSyntheticPageId = 1;
function idPage(page: Page) {
  const target = page as unknown as { __openclawReplayPageId?: number };
  if (!target.__openclawReplayPageId) {
    target.__openclawReplayPageId = nextSyntheticPageId++;
  }
  return target.__openclawReplayPageId;
}

function buildReplayMetadataEvent(params: {
  bootstrap: BrowserReplayBootstrap;
  capture: {
    events: Array<Record<string, unknown>>;
  };
}) {
  return {
    timestamp: Date.now(),
    type: 5,
    data: {
      tag: "recording-meta",
      payload: {
        session_key: params.bootstrap.sessionKey,
        run_id: params.bootstrap.runId,
        agent_id: params.bootstrap.agentId,
        trace_id: parseTraceIdFromTraceparent(params.bootstrap.traceparent),
        captured_events: params.capture.events.length,
      },
    },
  };
}

async function uploadPendingReplayEvents(params: {
  bootstrap: BrowserReplayBootstrap;
  capture: ReplayCaptureStateEntry;
}) {
  const publicKey = params.capture.uploadConfig?.publicKey?.trim();
  if (!publicKey) {
    return null;
  }
  const pendingEvents = params.capture.events.slice(params.capture.uploadedCount);
  if (pendingEvents.length === 0 && params.capture.metadataUploaded) {
    return null;
  }
  const lines: string[] = [];
  if (!params.capture.metadataUploaded) {
    lines.push(JSON.stringify(buildReplayMetadataEvent(params), null, 0));
  }
  for (const event of pendingEvents) {
    lines.push(JSON.stringify(event, null, 0));
  }
  const response = await globalThis.fetch(
    buildReplayIngestUrl(params.capture.uploadConfig?.serverUrl, params.capture.recordingId),
    {
      method: "POST",
      headers: {
        "content-type": "application/x-ndjson",
        authorization: `Bearer ${publicKey}`,
      },
      body: lines.join("\n"),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `rrwebcloud ingest failed (${response.status}): ${body || response.statusText}`,
    );
  }
  params.capture.metadataUploaded = true;
  params.capture.uploadedCount = params.capture.events.length;
  params.capture.previewUrl =
    params.capture.previewUrl ||
    buildReplayPreviewUrl(params.capture.uploadConfig?.serverUrl, params.capture.recordingId);
  return params.capture.previewUrl;
}

export async function ensureReplayCaptureForPage(params: {
  page: Page;
  profileName: string;
  targetId: string;
}) {
  return await ensureReplayRecorderOnPage(params);
}

export async function collectAndPersistReplaySession(params: {
  page: Page;
  profileName: string;
  targetId: string;
}) {
  const key = normalizeTargetKey(params.profileName, params.targetId);
  const registered = state.targetContexts.get(key);
  const bootstrap = registered?.bootstrap;
  if (!registered || !bootstrap) {
    return null;
  }
  const capture = await ensureReplayRecorderOnPage(params).catch(() => null);
  if (capture?.uploadConfig?.publicKey?.trim()) {
    await uploadPendingReplayEvents({ bootstrap, capture }).catch(() => null);
    await setReplaySessionMarkerOnPage({
      page: params.page,
      recordingId: capture.recordingId,
      previewUrl: capture.previewUrl,
      traceId: parseTraceIdFromTraceparent(bootstrap.traceparent),
    });
    return await upsertReplayMapping({
      sessionKey: bootstrap.sessionKey,
      replaySessionId: capture.recordingId,
      replayUrl: capture.previewUrl,
      provider: bootstrap.provider,
      runId: bootstrap.runId,
      agentId: bootstrap.agentId,
      traceparent: bootstrap.traceparent,
      tracestate: bootstrap.tracestate,
      traceId: parseTraceIdFromTraceparent(bootstrap.traceparent),
    });
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
