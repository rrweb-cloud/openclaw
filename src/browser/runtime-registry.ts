import path from "node:path";

export type ManagedBrowserExtensionRegistration = {
  sourceId: string;
  profiles: string[];
  extensionPaths: string[];
};

export type BrowserReplayContext = {
  cdpUrl: string;
  profile?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  traceparent?: string;
  tracestate?: string;
  replaySessionId?: string;
  replayUrl?: string;
  replayServerUrl?: string;
  updatedAt: string;
};

const managedBrowserExtensionsBySource = new Map<string, ManagedBrowserExtensionRegistration>();
const replayContextByCdpUrl = new Map<string, BrowserReplayContext>();

function normalizeString(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalizeProfileNames(profiles: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of profiles) {
    const value = normalizeString(raw);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeExtensionPaths(extensionPaths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of extensionPaths) {
    const value = normalizeString(raw);
    if (!value) {
      continue;
    }
    const resolved = path.resolve(value);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

function normalizeCdpUrl(cdpUrl: string): string {
  return normalizeString(cdpUrl).replace(/\/+$/, "");
}

export function registerManagedBrowserExtensions(
  registration: ManagedBrowserExtensionRegistration,
): void {
  const sourceId = normalizeString(registration.sourceId);
  if (!sourceId) {
    throw new Error("Managed browser extension registration requires a sourceId.");
  }
  managedBrowserExtensionsBySource.set(sourceId, {
    sourceId,
    profiles: normalizeProfileNames(registration.profiles),
    extensionPaths: normalizeExtensionPaths(registration.extensionPaths),
  });
}

export function unregisterManagedBrowserExtensions(sourceId: string): void {
  managedBrowserExtensionsBySource.delete(normalizeString(sourceId));
}

export function resolveManagedBrowserExtensionPaths(params: {
  profileName: string;
  configuredExtensions?: string[];
}): string[] {
  const profileName = normalizeString(params.profileName);
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const entry of normalizeExtensionPaths(params.configuredExtensions ?? [])) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    resolved.push(entry);
  }

  for (const registration of managedBrowserExtensionsBySource.values()) {
    if (!registration.profiles.includes(profileName)) {
      continue;
    }
    for (const entry of registration.extensionPaths) {
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      resolved.push(entry);
    }
  }

  return resolved;
}

export function setManagedBrowserReplayContext(context: BrowserReplayContext): void {
  const cdpUrl = normalizeCdpUrl(context.cdpUrl);
  if (!cdpUrl) {
    throw new Error("Browser replay context requires a cdpUrl.");
  }
  replayContextByCdpUrl.set(cdpUrl, {
    ...context,
    cdpUrl,
    updatedAt: normalizeString(context.updatedAt) || new Date().toISOString(),
  });
}

export function getManagedBrowserReplayContext(cdpUrl: string): BrowserReplayContext | null {
  return replayContextByCdpUrl.get(normalizeCdpUrl(cdpUrl)) ?? null;
}

export function clearManagedBrowserReplayContext(cdpUrl: string): void {
  replayContextByCdpUrl.delete(normalizeCdpUrl(cdpUrl));
}

export function clearManagedBrowserReplayContextsForSession(sessionKey: string): void {
  const normalizedSessionKey = normalizeString(sessionKey);
  if (!normalizedSessionKey) {
    return;
  }
  for (const [cdpUrl, context] of replayContextByCdpUrl.entries()) {
    if (context.sessionKey === normalizedSessionKey) {
      replayContextByCdpUrl.delete(cdpUrl);
    }
  }
}
