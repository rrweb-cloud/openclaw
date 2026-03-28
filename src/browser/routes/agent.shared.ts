import { toBrowserErrorResponse } from "../errors.js";
import type { PwAiModule } from "../pw-ai-module.js";
import { getPwAiModule as getPwAiModuleBase } from "../pw-ai-module.js";
import {
  applyReplayBootstrapToPage,
  buildBrowserReplayBootstrap,
  collectAndPersistReplaySession,
  getReplayMappingForSessionKey,
  registerReplayContextForTarget,
} from "../replay.js";
import { readReplayContextFromBrowserRequest } from "../replay.request.js";
import { setManagedBrowserReplayContext } from "../runtime-registry.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";
import { getProfileContext, jsonError } from "./utils.js";

export const SELECTOR_UNSUPPORTED_MESSAGE = [
  "Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
  "",
  "Example workflow:",
  "1. snapshot action to get page state with refs",
  '2. act with ref: "e123" to interact with element',
  "",
  "This is more reliable for modern SPAs.",
].join("\n");

export function readBody(req: BrowserRequest): Record<string, unknown> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body;
}

export function resolveTargetIdFromBody(body: Record<string, unknown>): string | undefined {
  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  return targetId || undefined;
}

export function resolveTargetIdFromQuery(query: Record<string, unknown>): string | undefined {
  const targetId = typeof query.targetId === "string" ? query.targetId.trim() : "";
  return targetId || undefined;
}

export function handleRouteError(ctx: BrowserRouteContext, res: BrowserResponse, err: unknown) {
  const mapped = ctx.mapTabError(err);
  if (mapped) {
    return jsonError(res, mapped.status, mapped.message);
  }
  const browserMapped = toBrowserErrorResponse(err);
  if (browserMapped) {
    return jsonError(res, browserMapped.status, browserMapped.message);
  }
  jsonError(res, 500, String(err));
}

export function resolveProfileContext(
  req: BrowserRequest,
  res: BrowserResponse,
  ctx: BrowserRouteContext,
): ProfileContext | null {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    jsonError(res, profileCtx.status, profileCtx.error);
    return null;
  }
  return profileCtx;
}

export async function getPwAiModule(): Promise<PwAiModule | null> {
  return await getPwAiModuleBase({ mode: "soft" });
}

export async function requirePwAi(
  res: BrowserResponse,
  feature: string,
): Promise<PwAiModule | null> {
  const mod = await getPwAiModule();
  if (mod) {
    return mod;
  }
  jsonError(
    res,
    501,
    [
      `Playwright is not available in this gateway build; '${feature}' is unsupported.`,
      "Install the full Playwright package (not playwright-core) and restart the gateway, or reinstall with browser support.",
      "Docs: /tools/browser#playwright-requirement",
    ].join("\n"),
  );
  return null;
}

type RouteTabContext = {
  profileCtx: ProfileContext;
  tab: Awaited<ReturnType<ProfileContext["ensureTabAvailable"]>>;
  cdpUrl: string;
};

type RouteTabPwContext = RouteTabContext & {
  pw: PwAiModule;
};

type RouteWithTabParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  run: (ctx: RouteTabContext) => Promise<T>;
};

export async function withRouteTabContext<T>(
  params: RouteWithTabParams<T>,
): Promise<T | undefined> {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return undefined;
  }
  try {
    const tab = await profileCtx.ensureTabAvailable(params.targetId);
    return await params.run({
      profileCtx,
      tab,
      cdpUrl: profileCtx.profile.cdpUrl,
    });
  } catch (err) {
    handleRouteError(params.ctx, params.res, err);
    return undefined;
  }
}

type RouteWithPwParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  feature: string;
  run: (ctx: RouteTabPwContext) => Promise<T>;
};

export async function withPlaywrightRouteContext<T>(
  params: RouteWithPwParams<T>,
): Promise<T | undefined> {
  return await withRouteTabContext({
    req: params.req,
    res: params.res,
    ctx: params.ctx,
    targetId: params.targetId,
    run: async ({ profileCtx, tab, cdpUrl }) => {
      const pw = await requirePwAi(params.res, params.feature);
      if (!pw) {
        return undefined as T | undefined;
      }
      const replayConfig = params.ctx.state().resolved.replay ?? {
        enabled: false,
        extensionPath: undefined,
        injectCorrelation: true,
        persistMappings: true,
      };
      const replayRequestContext =
        replayConfig.enabled && profileCtx.profile.driver === "openclaw"
          ? readReplayContextFromBrowserRequest(params.req)
          : null;
      const replayBootstrap = buildBrowserReplayBootstrap(replayRequestContext);
      if (replayBootstrap) {
        const existingMapping = replayConfig.persistMappings
          ? await getReplayMappingForSessionKey(replayBootstrap.sessionKey)
          : null;
        setManagedBrowserReplayContext({
          cdpUrl,
          profile: profileCtx.profile.name,
          sessionKey: replayBootstrap.sessionKey,
          runId: replayBootstrap.runId,
          agentId: replayBootstrap.agentId,
          traceparent: replayBootstrap.traceparent,
          tracestate: replayBootstrap.tracestate,
          replaySessionId: existingMapping?.replaySessionId,
          replayUrl: existingMapping?.replayUrl,
          updatedAt: new Date().toISOString(),
        });
        registerReplayContextForTarget({
          profileName: profileCtx.profile.name,
          targetId: tab.targetId,
          context: replayBootstrap,
        });
        if (replayConfig.injectCorrelation) {
          const page = await pw.getPageForTargetId({ cdpUrl, targetId: tab.targetId });
          await applyReplayBootstrapToPage({ page, bootstrap: replayBootstrap }).catch(
            () => undefined,
          );
        }
      }
      const result = await params.run({ profileCtx, tab, cdpUrl, pw });
      if (replayBootstrap && replayConfig.persistMappings) {
        const page = await pw
          .getPageForTargetId({ cdpUrl, targetId: tab.targetId })
          .catch(() => null);
        if (page) {
          const mapping = await collectAndPersistReplaySession({
            page,
            profileName: profileCtx.profile.name,
            targetId: tab.targetId,
          }).catch(() => null);
          if (mapping) {
            setManagedBrowserReplayContext({
              cdpUrl,
              profile: profileCtx.profile.name,
              sessionKey: mapping.sessionKey,
              runId: mapping.runId,
              agentId: mapping.agentId,
              traceparent: mapping.traceparent,
              tracestate: mapping.tracestate,
              replaySessionId: mapping.replaySessionId,
              replayUrl: mapping.replayUrl,
              updatedAt: mapping.updatedAt,
            });
          }
        }
      }
      return result;
    },
  });
}
