import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const registerLogTransportMock = vi.hoisted(() => vi.fn());

const telemetryState = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const tracer = {
    startSpan: vi.fn((_name: string, _opts?: unknown, _parentCtx?: unknown) => ({
      end: vi.fn(),
      setStatus: vi.fn(),
      setAttribute: vi.fn(),
      _parentCtx: _parentCtx,
    })),
  };
  const meter = {
    createCounter: vi.fn((name: string) => {
      const counter = { add: vi.fn() };
      counters.set(name, counter);
      return counter;
    }),
    createHistogram: vi.fn((name: string) => {
      const histogram = { record: vi.fn() };
      histograms.set(name, histogram);
      return histogram;
    }),
  };
  return { counters, histograms, tracer, meter };
});

const sdkStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const sdkShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logEmit = vi.hoisted(() => vi.fn());
const logShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockRootContext = vi.hoisted(() => ({ _type: "root" }));

vi.mock("@opentelemetry/api", () => ({
  context: {
    active: () => mockRootContext,
  },
  metrics: {
    getMeter: () => telemetryState.meter,
  },
  trace: {
    getTracer: () => telemetryState.tracer,
    setSpan: (_ctx: unknown, span: unknown) => ({ _type: "with-parent", _span: span }),
  },
  SpanKind: {
    INTERNAL: 0,
    SERVER: 1,
    CLIENT: 2,
    PRODUCER: 3,
    CONSUMER: 4,
  },
  SpanStatusCode: {
    UNSET: 0,
    OK: 1,
    ERROR: 2,
  },
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    start = sdkStart;
    shutdown = sdkShutdown;
  },
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {},
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
  OTLPMetricExporter: class {},
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: class {},
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: class {},
  LoggerProvider: class {
    addLogRecordProcessor = vi.fn();
    getLogger = vi.fn(() => ({
      emit: logEmit,
    }));
    shutdown = logShutdown;
  },
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  PeriodicExportingMetricReader: class {},
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  ParentBasedSampler: class {},
  TraceIdRatioBasedSampler: class {},
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs: Record<string, unknown>) => attrs),
  Resource: class {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_value?: unknown) {}
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

vi.mock("../api.js", async () => {
  const actual = await vi.importActual<typeof import("../api.js")>("../api.js");
  return {
    ...actual,
    registerLogTransport: registerLogTransportMock,
  };
});

import { upsertReplayMapping } from "../../../src/browser/replay.js";
import { emitDiagnosticEvent } from "../api.js";
import { createDiagnosticsOtelService } from "./service.js";

describe("diagnostics-otel service – span hierarchy", () => {
  const startedServices: Array<ReturnType<typeof createDiagnosticsOtelService>> = [];

  afterEach(async () => {
    for (const service of startedServices.splice(0)) {
      await Promise.resolve(service.stop?.({} as never)).catch(() => undefined);
    }
  });

  beforeEach(() => {
    telemetryState.counters.clear();
    telemetryState.histograms.clear();
    telemetryState.tracer.startSpan.mockClear();
    telemetryState.meter.createCounter.mockClear();
    telemetryState.meter.createHistogram.mockClear();
    sdkStart.mockClear();
    sdkShutdown.mockClear();
    logEmit.mockClear();
    logShutdown.mockClear();
    registerLogTransportMock.mockReset();
  });

  function createService() {
    const service = createDiagnosticsOtelService();
    startedServices.push(service);
    return service;
  }

  function createTestCtx(otelOverrides?: { captureContent?: boolean }) {
    return {
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf" as const,
            traces: true,
            metrics: true,
            logs: false,
            ...otelOverrides,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      stateDir: "/tmp/openclaw-diagnostics-otel-test",
    };
  }

  test("run.completed emits gen_ai.* span attributes alongside openclaw.*", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-usage-1",
      channel: "webchat",
      provider: "openai",
      model: "gpt-5.2",
      operationName: "chat",
      responseId: "chatcmpl-abc123",
      responseModel: "gpt-5.2-2025-06-01",
      finishReasons: ["stop"],
      sessionKey: "agent:main:main",
      sessionId: "sess-001",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 80,
        cacheWrite: 0,
        promptTokens: 180,
        total: 230,
      },
      durationMs: 1500,
    });

    const spanCall = telemetryState.tracer.startSpan.mock.calls[0];
    expect(spanCall[0]).toBe("invoke_agent");

    const attrs = (spanCall[1] as any)?.attributes;
    // gen_ai.* inference attributes should NOT be on the turn span —
    // they belong on child chat spans only.
    // gen_ai.operation.name IS set on the turn span (as "invoke_agent" per agent spec).
    expect(attrs["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(attrs["gen_ai.provider.name"]).toBe("openai");
    expect(attrs["gen_ai.request.model"]).toBeUndefined();
    expect(attrs["gen_ai.response.id"]).toBeUndefined();
    expect(attrs["gen_ai.response.model"]).toBeUndefined();
    expect(attrs["gen_ai.response.finish_reasons"]).toBeUndefined();
    // conversation.id is kept as it's a session-level attribute
    expect(attrs["gen_ai.conversation.id"]).toBe("sess-001");

    // gen_ai.agent.* identity attributes
    expect(attrs["gen_ai.agent.id"]).toBe("main");
    expect(attrs["gen_ai.agent.name"]).toBeUndefined(); // no identity configured

    // openclaw.* envelope attributes preserved
    expect(attrs["openclaw.channel"]).toBe("webchat");
    expect(attrs["openclaw.provider"]).toBe("openai");
    expect(attrs["openclaw.model"]).toBe("gpt-5.2");
    expect(attrs["openclaw.tokens.input"]).toBe(100);
    expect(attrs["openclaw.tokens.output"]).toBe(50);
    expect(attrs["openclaw.tokens.cache_read"]).toBe(80);
    // gen_ai.usage.* token attributes should NOT be on the turn span
    expect(attrs["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
    expect(attrs["gen_ai.usage.cache_creation.input_tokens"]).toBeUndefined();
    expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attrs["gen_ai.usage.output_tokens"]).toBeUndefined();

    await service.stop?.({} as never);
  });

  test("run.completed attaches replay metadata when a replay mapping exists", async () => {
    const service = createService();
    await service.start(createTestCtx());

    await upsertReplayMapping({
      sessionKey: "agent:main:main",
      replaySessionId: "replay-123",
      replayUrl: "https://rrwebcloud.example/sessions/replay-123",
      provider: "rrwebcloud",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    });

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-replay-1",
      channel: "webchat",
      provider: "openai",
      model: "gpt-5.2",
      sessionKey: "agent:main:main",
      sessionId: "sess-001",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        promptTokens: 1,
        total: 2,
      },
      durationMs: 50,
    });

    const spanCall = telemetryState.tracer.startSpan.mock.calls.at(-1);
    const attrs = (spanCall?.[1] as any)?.attributes;
    expect(attrs["openclaw.replay.session_id"]).toBe("replay-123");
    expect(attrs["openclaw.replay.url"]).toBe("https://rrwebcloud.example/sessions/replay-123");
    expect(attrs["openclaw.replay.provider"]).toBe("rrwebcloud");

    await service.stop?.({} as never);
  });

  test("model.inference spans are children of run.started span when runId is present", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-1",
      sessionId: "sess-1",
    });

    emitDiagnosticEvent({
      type: "model.inference",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 20, output: 10, total: 30 },
      durationMs: 100,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    expect(calls[0]?.[0]).toBe("invoke_agent");
    expect(calls[1]?.[0]).toBe("chat gpt-5.2");
    expect(calls[1]?.[2]).toEqual(expect.objectContaining({ _type: "with-parent" }));

    await service.stop?.({} as never);
  });

  test("inference spans use SpanKind.CLIENT, tool spans use SpanKind.INTERNAL", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "model.inference",
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 10, output: 5, total: 15 },
    });

    emitDiagnosticEvent({
      type: "tool.execution",
      toolName: "web_search",
      durationMs: 200,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    // SpanKind.CLIENT = 2, SpanKind.INTERNAL = 0
    expect((calls[0][1] as any)?.kind).toBe(2);
    expect((calls[1][1] as any)?.kind).toBe(0);

    await service.stop?.({} as never);
  });

  test("tool spans with matching runId are children of the run span", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-parent-child",
      sessionId: "sess-1",
    });

    emitDiagnosticEvent({
      type: "tool.execution",
      runId: "run-parent-child",
      toolName: "web_search",
      toolType: "function",
      toolCallId: "call-1",
      durationMs: 200,
    });
    emitDiagnosticEvent({
      type: "tool.execution",
      runId: "run-parent-child",
      toolName: "read",
      toolType: "function",
      toolCallId: "call-2",
      durationMs: 50,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    // 3 spans: 1 run parent + 2 child tool spans
    expect(calls).toHaveLength(3);

    // First call is the run span
    expect(calls[0][0]).toBe("invoke_agent");
    const parentSpan = telemetryState.tracer.startSpan.mock.results[0]?.value;

    // Tool spans should have been created with a parent context derived from the run span
    expect(calls[1][0]).toBe("web_search");
    const toolParentCtx1 = calls[1][2] as { _type: string; _span: unknown };
    expect(toolParentCtx1._type).toBe("with-parent");
    expect(toolParentCtx1._span).toBe(parentSpan);

    expect(calls[2][0]).toBe("read");
    const toolParentCtx2 = calls[2][2] as { _type: string; _span: unknown };
    expect(toolParentCtx2._type).toBe("with-parent");
    expect(toolParentCtx2._span).toBe(parentSpan);

    // Tool spans end immediately; the run span stays open until run.completed.
    expect(parentSpan.end).not.toHaveBeenCalled();
    expect(telemetryState.tracer.startSpan.mock.results[1]?.value.end).toHaveBeenCalled();
    expect(telemetryState.tracer.startSpan.mock.results[2]?.value.end).toHaveBeenCalled();

    await service.stop?.({} as never);
  });

  test("tool spans with matching runId are children of the run span (not inference span)", async () => {
    const service = createService();
    await service.start(createTestCtx({ captureContent: true }));

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-tool-parent-1",
      sessionId: "sess-1",
    });

    emitDiagnosticEvent({
      type: "model.inference.started",
      runId: "run-tool-parent-1",
      callIndex: 0,
      provider: "openai",
      model: "gpt-5.2",
      inputMessages: [{ role: "user" as const, parts: [{ type: "text" as const, content: "hi" }] }],
    });

    emitDiagnosticEvent({
      type: "tool.execution",
      runId: "run-tool-parent-1",
      toolName: "web_search",
      toolType: "function",
      toolCallId: "call-1",
      durationMs: 200,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    const runSpan = telemetryState.tracer.startSpan.mock.results.find((r, idx) =>
      calls[idx]?.[0]?.startsWith("invoke_agent"),
    )?.value;
    expect(runSpan).toBeDefined();

    const toolCall = calls.find((c) => c[0] === "web_search");
    expect(toolCall).toBeDefined();
    const toolParentCtx = toolCall?.[2] as { _type: string; _span: unknown };
    expect(toolParentCtx._type).toBe("with-parent");
    expect(toolParentCtx._span).toBe(runSpan);

    emitDiagnosticEvent({
      type: "model.inference",
      runId: "run-tool-parent-1",
      callIndex: 0,
      provider: "openai",
      model: "gpt-5.2",
      usage: { input: 10, output: 5, total: 15 },
      outputMessages: [
        { role: "assistant" as const, parts: [{ type: "text" as const, content: "ok" }] },
      ],
    });

    await service.stop?.({} as never);
  });

  test("tool events without runId create standalone spans (backward compat)", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "tool.execution",
      toolName: "exec",
      toolType: "function",
      toolCallId: "call-no-run",
      durationMs: 100,
    });

    // Span should be created immediately (no buffering)
    expect(telemetryState.tracer.startSpan).toHaveBeenCalledTimes(1);
    expect(telemetryState.tracer.startSpan.mock.calls[0][0]).toBe("exec");
    // No parent context
    expect(telemetryState.tracer.startSpan.mock.calls[0][2]).toBeUndefined();

    await service.stop?.({} as never);
  });

  test("tool events with runId but without run.started are standalone spans", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "tool.execution",
      runId: "run-orphaned",
      toolName: "web_search",
      durationMs: 200,
    });

    // Tool span should be created immediately without a parent
    expect(telemetryState.tracer.startSpan).toHaveBeenCalledTimes(1);
    expect(telemetryState.tracer.startSpan.mock.calls[0][0]).toBe("web_search");
    expect(telemetryState.tracer.startSpan.mock.calls[0][2]).toBeUndefined();

    await service.stop?.({} as never);
  });

  test("agent.turn spans are nested under openclaw.message root span", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "telegram:agent:123",
      queueDepth: 1,
    });

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-nested-1",
      sessionId: "sess-nested-1",
      sessionKey: "telegram:agent:123",
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    expect(calls[0]?.[0]).toBe("openclaw.message");
    expect(calls[1]?.[0]).toBe("invoke_agent");
    // agent.turn should have a parent context pointing to the root span
    expect(calls[1]?.[2]).toEqual(expect.objectContaining({ _type: "with-parent" }));

    await service.stop?.({} as never);
  });

  test("agent span includes gen_ai.agent.name when identity is configured", async () => {
    const service = createService();
    await service.start({
      ...createTestCtx(),
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf" as const,
            traces: true,
            metrics: true,
          },
        },
        agents: {
          list: [{ id: "main", workspace: "/tmp", identity: { name: "Samantha" } }],
        },
      },
    });

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-identity-1",
      sessionKey: "agent:main:telegram:group:123",
      sessionId: "sess-identity",
      channel: "telegram",
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    expect(calls[0]?.[0]).toBe("invoke_agent Samantha");
    const attrs = (calls[0]?.[1] as any)?.attributes;
    expect(attrs["gen_ai.agent.id"]).toBe("main");
    expect(attrs["gen_ai.agent.name"]).toBe("Samantha");
    expect(attrs["gen_ai.operation.name"]).toBe("invoke_agent");

    await service.stop?.({} as never);
  });

  test("agent span uses agentId from subagent sessionKey", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-sub-1",
      sessionKey: "agent:helper:subagent:550e8400-e29b-41d4-a716-446655440000",
      sessionId: "sess-sub",
      channel: "telegram",
    });

    const attrs = (telemetryState.tracer.startSpan.mock.calls[0]?.[1] as any)?.attributes;
    expect(attrs["gen_ai.agent.id"]).toBe("helper");
    expect(attrs["gen_ai.operation.name"]).toBe("invoke_agent");

    await service.stop?.({} as never);
  });

  test("message.processed ends the root span and sets attributes", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "telegram:agent:456",
      queueDepth: 1,
    });

    const rootSpan = telemetryState.tracer.startSpan.mock.results[0]?.value;
    expect(rootSpan).toBeDefined();

    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "telegram:agent:456",
      outcome: "completed",
      durationMs: 250,
      messageId: "msg-001",
    });

    expect(rootSpan.setAttribute).toHaveBeenCalledWith("openclaw.outcome", "completed");
    expect(rootSpan.setAttribute).toHaveBeenCalledWith("openclaw.durationMs", 250);
    expect(rootSpan.setAttribute).toHaveBeenCalledWith("openclaw.messageId", "msg-001");
    expect(rootSpan.setStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK
    expect(rootSpan.end).toHaveBeenCalled();

    await service.stop?.({} as never);
  });

  test("message.processed sets ERROR status on error outcome", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "telegram:agent:789",
      queueDepth: 1,
    });

    const rootSpan = telemetryState.tracer.startSpan.mock.results[0]?.value;

    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "telegram:agent:789",
      outcome: "error",
      error: "Model timeout",
    });

    expect(rootSpan.setStatus).toHaveBeenCalledWith({
      code: 2, // SpanStatusCode.ERROR
      message: "Model timeout",
    });
    expect(rootSpan.end).toHaveBeenCalled();

    await service.stop?.({} as never);
  });

  test("message.processed without matching message.queued does not crash", async () => {
    const service = createService();
    await service.start(createTestCtx());

    // No message.queued emitted — should not throw
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "telegram:agent:unknown",
      outcome: "completed",
    });

    // Only metrics should be recorded, no span created
    expect(telemetryState.counters.get("openclaw.message.processed")?.add).toHaveBeenCalled();
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalled();

    await service.stop?.({} as never);
  });

  test("subagent.spawned creates wrapper span under parent trace", async () => {
    const service = createService();
    await service.start(createTestCtx());

    // Parent agent queues a message (creates root trace)
    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "agent:main:telegram:dm:123",
      queueDepth: 1,
    });

    const parentRootSpan = telemetryState.tracer.startSpan.mock.results[0]?.value;
    expect(parentRootSpan).toBeDefined();

    // Parent run starts (creates invoke_agent span)
    emitDiagnosticEvent({
      type: "run.started",
      runId: "parent-run-1",
      sessionKey: "agent:main:telegram:dm:123",
      sessionId: "sess-parent",
      channel: "telegram",
    });

    const parentRunSpan = telemetryState.tracer.startSpan.mock.results.find(
      (_r: unknown, idx: number) =>
        telemetryState.tracer.startSpan.mock.calls[idx]?.[0]?.startsWith("invoke_agent"),
    )?.value;
    expect(parentRunSpan).toBeDefined();

    // Parent spawns a subagent
    emitDiagnosticEvent({
      type: "subagent.spawned",
      parentSessionKey: "agent:main:telegram:dm:123",
      childSessionKey: "agent:helper:subagent:550e8400-e29b-41d4-a716-446655440000",
      childRunId: "child-run-1",
      agentId: "helper",
    });

    // Wrapper span should be a child of invoke_agent (run span), not root
    const calls = telemetryState.tracer.startSpan.mock.calls;
    const wrapperCall = calls.find((c: unknown[]) => c[0] === "openclaw.subagent helper");
    expect(wrapperCall).toBeDefined();

    const wrapperParentCtx = wrapperCall?.[2] as { _type: string; _span: unknown };
    expect(wrapperParentCtx._type).toBe("with-parent");
    expect(wrapperParentCtx._span).toBe(parentRunSpan);

    const wrapperOpts = wrapperCall?.[1] as { attributes: Record<string, string> };
    expect(wrapperOpts.attributes["openclaw.parent.sessionKey"]).toBe("agent:main:telegram:dm:123");
    expect(wrapperOpts.attributes["gen_ai.agent.id"]).toBe("helper");

    await service.stop?.({} as never);
  });

  test("subagent root span is child of wrapper span", async () => {
    const service = createService();
    await service.start(createTestCtx());

    // Parent queues message
    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "agent:main:telegram:dm:123",
      queueDepth: 1,
    });

    // Parent spawns subagent
    emitDiagnosticEvent({
      type: "subagent.spawned",
      parentSessionKey: "agent:main:telegram:dm:123",
      childSessionKey: "agent:helper:subagent:sub-uuid-1",
      agentId: "helper",
    });

    const wrapperSpan = telemetryState.tracer.startSpan.mock.results.find(
      (_r: unknown, idx: number) =>
        telemetryState.tracer.startSpan.mock.calls[idx]?.[0] === "openclaw.subagent helper",
    )?.value;
    expect(wrapperSpan).toBeDefined();

    // Subagent's message.queued fires — should nest under wrapper
    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "dispatch",
      sessionKey: "agent:helper:subagent:sub-uuid-1",
      queueDepth: 1,
    });

    const childRootCall = telemetryState.tracer.startSpan.mock.calls.find(
      (c: unknown[], idx: number) =>
        c[0] === "openclaw.message" &&
        idx > 0 && // skip the parent's openclaw.message
        (c[2] as { _span?: unknown } | undefined)?._span === wrapperSpan,
    );
    expect(childRootCall).toBeDefined();

    await service.stop?.({} as never);
  });

  test("subagent message.processed ends both root and wrapper spans", async () => {
    const service = createService();
    await service.start(createTestCtx());

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      sessionKey: "agent:main:telegram:dm:456",
      queueDepth: 1,
    });

    emitDiagnosticEvent({
      type: "subagent.spawned",
      parentSessionKey: "agent:main:telegram:dm:456",
      childSessionKey: "agent:helper:subagent:sub-uuid-2",
      agentId: "helper",
    });

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "dispatch",
      sessionKey: "agent:helper:subagent:sub-uuid-2",
      queueDepth: 1,
    });

    const calls = telemetryState.tracer.startSpan.mock.calls;
    const wrapperSpan = telemetryState.tracer.startSpan.mock.results.find(
      (_r: unknown, idx: number) => calls[idx]?.[0] === "openclaw.subagent helper",
    )?.value;
    const childRootSpan = telemetryState.tracer.startSpan.mock.results.find(
      (_r: unknown, idx: number) =>
        calls[idx]?.[0] === "openclaw.message" &&
        (calls[idx]?.[2] as { _span?: unknown } | undefined)?._span === wrapperSpan,
    )?.value;

    expect(wrapperSpan).toBeDefined();
    expect(childRootSpan).toBeDefined();

    // Process the subagent's message
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "agent:helper:subagent:sub-uuid-2",
      outcome: "completed",
      durationMs: 500,
    });

    // Both the child root span and the wrapper span should be ended
    expect(childRootSpan.end).toHaveBeenCalled();
    expect(wrapperSpan.end).toHaveBeenCalled();

    await service.stop?.({} as never);
  });

  test("subagent.spawned without active parent trace is a no-op", async () => {
    const service = createService();
    await service.start(createTestCtx());

    // No parent message.queued — spawned event should not crash
    emitDiagnosticEvent({
      type: "subagent.spawned",
      parentSessionKey: "agent:main:nonexistent",
      childSessionKey: "agent:helper:subagent:orphan-uuid",
      agentId: "helper",
    });

    // No wrapper span should be created
    const calls = telemetryState.tracer.startSpan.mock.calls;
    const wrapperCall = calls.find((c: unknown[]) =>
      (c[0] as string).startsWith("openclaw.subagent"),
    );
    expect(wrapperCall).toBeUndefined();

    await service.stop?.({} as never);
  });
});
