import type { BrowserReplayRequestContext } from "./replay.js";
import type { BrowserRequest } from "./routes/types.js";

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function attachReplayContextToBody<T extends Record<string, unknown>>(
  body: T,
  replayContext?: BrowserReplayRequestContext | null,
): T {
  if (!replayContext?.sessionKey) {
    return body;
  }
  return { ...body, replayContext } satisfies T;
}

export function attachReplayContextToQuery(
  query: Record<string, string | number | boolean | undefined> | undefined,
  replayContext?: BrowserReplayRequestContext | null,
) {
  if (!replayContext?.sessionKey) {
    return query;
  }
  return {
    ...query,
    replaySessionKey: replayContext.sessionKey,
    replayRunId: replayContext.runId,
    replayAgentId: replayContext.agentId,
    replayTraceparent: replayContext.traceparent,
    replayTracestate: replayContext.tracestate,
  };
}

export function readReplayContextFromBrowserRequest(
  req: BrowserRequest,
): BrowserReplayRequestContext | null {
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;
  const embedded =
    body?.replayContext &&
    typeof body.replayContext === "object" &&
    !Array.isArray(body.replayContext)
      ? (body.replayContext as Record<string, unknown>)
      : null;
  const sessionKey = readString(embedded?.sessionKey) ?? readString(req.query.replaySessionKey);
  if (!sessionKey) {
    return null;
  }
  return {
    sessionKey,
    runId: readString(embedded?.runId) ?? readString(req.query.replayRunId),
    agentId: readString(embedded?.agentId) ?? readString(req.query.replayAgentId),
    traceparent: readString(embedded?.traceparent) ?? readString(req.query.replayTraceparent),
    tracestate: readString(embedded?.tracestate) ?? readString(req.query.replayTracestate),
  };
}
