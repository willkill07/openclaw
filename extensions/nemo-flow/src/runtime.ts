import type { AgentStreamingLlmMiddlewareContext } from "openclaw/plugin-sdk/core";
import type { NemoFlowPluginConfig } from "./config.js";

type JsonRecord = Record<string, unknown>;
type StreamFn = AgentStreamingLlmMiddlewareContext["streamFn"];

type StreamLike = AsyncIterable<unknown> & {
  result?: () => Promise<unknown>;
};

type NemoFlowScopeHandle = unknown;
type NemoFlowScopeStack = unknown;

type NemoFlowBindings = {
  createScopeStack: () => NemoFlowScopeStack;
  setThreadScopeStack: (stack: NemoFlowScopeStack) => void;
  pushScope: (
    name: string,
    scopeType: number,
    handle?: NemoFlowScopeHandle | null,
    attributes?: number | null,
    data?: unknown,
    metadata?: unknown,
  ) => NemoFlowScopeHandle;
  popScope: (handle: NemoFlowScopeHandle) => void;
  toolCallExecuteAsync: (
    name: string,
    args: unknown,
    func: (arg: unknown) => unknown,
    handle?: NemoFlowScopeHandle | null,
    attributes?: number | null,
    data?: unknown,
    metadata?: unknown,
  ) => Promise<unknown>;
  llmStreamCallExecute: (
    name: string,
    request: unknown,
    func: (request: unknown) => unknown,
    collector?: (chunk: unknown) => unknown,
    finalizer?: () => unknown,
    handle?: NemoFlowScopeHandle | null,
    attributes?: number | null,
    data?: unknown,
    metadata?: unknown,
    modelName?: string | null,
  ) => Promise<{ next: () => Promise<unknown | null> }>;
  pushStreamChunk: (streamId: number, chunk: unknown) => boolean;
  endStream: (streamId: number) => void;
  ScopeType: {
    Agent: number;
  };
};

type NemoFlowPluginHost = {
  defaultConfig: () => NemoFlowPluginConfig;
  validate: (config: NemoFlowPluginConfig) => {
    diagnostics?: Array<{
      level?: string;
      code?: string;
      field?: string;
      message?: string;
    }>;
  };
  initialize: (config: NemoFlowPluginConfig) => Promise<unknown>;
  clear: () => void;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type NemoFlowModules = {
  bindings: NemoFlowBindings;
  pluginHost: NemoFlowPluginHost;
};

type RuntimeState = {
  modules?: NemoFlowModules;
  loadPromise?: Promise<NemoFlowModules | null>;
  initPromise?: Promise<boolean>;
  initialized: boolean;
  activeConfig?: NemoFlowPluginConfig;
  unavailableReason?: string;
  unavailableLogged: boolean;
  sessionScopes: Map<string, NemoFlowScopeStack>;
  sessionRootScopes: Map<string, NemoFlowScopeHandle>;
};

const TOOL_ATTR_LOCAL = 0b01;
const LLM_ATTR_STREAMING = 0b10;

const state: RuntimeState = {
  initialized: false,
  unavailableLogged: false,
  sessionScopes: new Map(),
  sessionRootScopes: new Map(),
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizeJsonObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

async function loadModules(): Promise<NemoFlowModules | null> {
  try {
    const [bindingsModule, pluginHostModule] = await Promise.all([
      import("nemo-flow-node"),
      import("nemo-flow-node/plugin"),
    ]);
    return {
      bindings: bindingsModule as unknown as NemoFlowBindings,
      pluginHost: pluginHostModule as unknown as NemoFlowPluginHost,
    };
  } catch (error) {
    state.unavailableReason = String(error);
    return null;
  }
}

async function ensureModules(logger: Logger): Promise<NemoFlowModules | null> {
  if (state.modules) {
    return state.modules;
  }
  if (!state.loadPromise) {
    state.loadPromise = loadModules();
  }
  const modules = await state.loadPromise;
  if (modules) {
    state.modules = modules;
    return modules;
  }
  if (!state.unavailableLogged) {
    logger.warn(
      `nemo-flow unavailable; execution wrapping disabled (${state.unavailableReason ?? "unknown error"})`,
    );
    state.unavailableLogged = true;
  }
  return null;
}

function logPluginDiagnostics(
  logger: Logger,
  diagnostics: Array<{ level?: string; code?: string; field?: string; message?: string }> = [],
): boolean {
  let hasErrors = false;
  for (const diagnostic of diagnostics) {
    const summary = [diagnostic.code, diagnostic.field, diagnostic.message]
      .filter(Boolean)
      .join(" ");
    if (diagnostic.level === "error") {
      hasErrors = true;
      logger.warn(`nemo-flow host config error: ${summary}`);
      continue;
    }
    logger.info(`nemo-flow host config warning: ${summary}`);
  }
  return hasErrors;
}

export function getNemoFlowRuntimeStatus(): {
  initialized: boolean;
  wrappingActive: boolean;
  unavailableReason?: string;
} {
  return {
    initialized: state.initialized,
    wrappingActive: state.initialized,
    ...(state.unavailableReason ? { unavailableReason: state.unavailableReason } : {}),
  };
}

export async function initializeNemoFlowGateway(params: {
  logger: Logger;
  config: NemoFlowPluginConfig;
}): Promise<boolean> {
  const modules = await ensureModules(params.logger);
  if (!modules) {
    return false;
  }
  if (state.initialized && state.activeConfig === params.config) {
    return true;
  }
  if (!state.initPromise) {
    state.initPromise = (async () => {
      const report = modules.pluginHost.validate(params.config);
      if (logPluginDiagnostics(params.logger, report?.diagnostics)) {
        return false;
      }
      try {
        await modules.pluginHost.initialize(params.config);
        state.initialized = true;
        state.activeConfig = params.config;
        return true;
      } catch (error) {
        params.logger.warn(`nemo-flow initialization failed; wrapping disabled (${String(error)})`);
        return false;
      }
    })();
  }
  return await state.initPromise;
}

export async function shutdownNemoFlowGateway(params: { logger: Logger }): Promise<void> {
  try {
    state.modules?.pluginHost.clear();
  } catch (error) {
    params.logger.warn(`nemo-flow shutdown failed (${String(error)})`);
  }
  for (const rootHandle of state.sessionRootScopes.values()) {
    try {
      state.modules?.bindings.popScope(rootHandle);
    } catch {
      // ignore cleanup errors
    }
  }
  state.sessionRootScopes.clear();
  state.sessionScopes.clear();
  state.initialized = false;
  state.activeConfig = undefined;
  state.initPromise = undefined;
}

async function ensureInitialized(
  logger: Logger,
  config: NemoFlowPluginConfig,
): Promise<NemoFlowModules | null> {
  const initialized = await initializeNemoFlowGateway({ logger, config });
  return initialized ? (state.modules ?? null) : null;
}

function sessionScopeKey(sessionId?: string, sessionKey?: string): string {
  return sessionId?.trim() || sessionKey?.trim() || "__openclaw_default__";
}

function ensureSessionScope(modules: NemoFlowModules, sessionId?: string, sessionKey?: string) {
  const key = sessionScopeKey(sessionId, sessionKey);
  let stack = state.sessionScopes.get(key);
  if (!stack) {
    stack = modules.bindings.createScopeStack();
    state.sessionScopes.set(key, stack);
  }
  return stack;
}

function ensureSessionRootScope(
  modules: NemoFlowModules,
  stack: NemoFlowScopeStack,
  sessionId?: string,
  sessionKey?: string,
) {
  const key = sessionScopeKey(sessionId, sessionKey);
  let rootHandle = state.sessionRootScopes.get(key);
  if (!rootHandle) {
    modules.bindings.setThreadScopeStack(stack);
    rootHandle = modules.bindings.pushScope("openclaw.agent", modules.bindings.ScopeType.Agent);
    state.sessionRootScopes.set(key, rootHandle);
  }
  return rootHandle;
}

function withSessionScope(modules: NemoFlowModules, sessionId?: string, sessionKey?: string): void {
  const stack = ensureSessionScope(modules, sessionId, sessionKey);
  ensureSessionRootScope(modules, stack, sessionId, sessionKey);
  modules.bindings.setThreadScopeStack(stack);
}

function buildLlmRequest(params: {
  provider: string;
  modelId: string;
  model: unknown;
  context: unknown;
  options: unknown;
}) {
  const options = asRecord(params.options);
  const headers = normalizeJsonObject(options.headers);
  return {
    headers,
    content: {
      provider: params.provider,
      model: params.modelId,
      modelInfo: normalizeJsonObject(params.model),
      context: params.context ?? null,
      options,
    },
  };
}

function applyRequestToStreamCall(params: {
  request: unknown;
  context: unknown;
  options: unknown;
}): { context: unknown; options: unknown } {
  const request = asRecord(params.request);
  const content = asRecord(request.content);
  return {
    context: content.context ?? params.context,
    options: content.options ?? params.options,
  };
}

function buildFinalStreamResponse(chunks: unknown[]): unknown {
  return {
    chunks,
  };
}

export async function executeToolWithNemoFlow(params: {
  logger: Logger;
  config: NemoFlowPluginConfig;
  toolName: string;
  args: unknown;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  agentId?: string;
  execute: (args: unknown) => Promise<unknown>;
}): Promise<unknown> {
  const modules = await ensureInitialized(params.logger, params.config);
  if (!modules) {
    return await params.execute(params.args);
  }

  withSessionScope(modules, params.sessionId, params.sessionKey);

  return await modules.bindings.toolCallExecuteAsync(
    params.toolName,
    params.args,
    async (effectiveArgs) => await params.execute(effectiveArgs),
    null,
    TOOL_ATTR_LOCAL,
    null,
    {
      ...(params.runId && { runId: params.runId }),
      ...(params.agentId && { agentId: params.agentId }),
      ...(params.sessionId && { sessionId: params.sessionId }),
      ...(params.sessionKey && { sessionKey: params.sessionKey }),
    },
  );
}

export function wrapStreamFnWithNemoFlow(params: {
  logger: Logger;
  config: NemoFlowPluginConfig;
  provider: string;
  modelId: string;
  agentId?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  streamFn: StreamFn;
}): StreamFn {
  const wrapped: StreamFn = ((
    model: Parameters<StreamFn>[0],
    context: Parameters<StreamFn>[1],
    options: Parameters<StreamFn>[2],
  ) => {
    const stream = (async () => {
      const modules = await ensureInitialized(params.logger, params.config);
      if (!modules) {
        return params.streamFn(model, context, options) as unknown as StreamLike;
      }

      withSessionScope(modules, params.sessionId, params.sessionKey);

      const request = buildLlmRequest({
        provider: params.provider,
        modelId: params.modelId,
        model,
        context,
        options,
      });
      let underlyingStreamPromise: Promise<StreamLike> | null = null;
      let underlyingPumpPromise: Promise<void> | null = null;
      let underlyingStreamFailed = false;
      let underlyingStreamFailure: unknown;
      const collectedChunks: unknown[] = [];

      const llmStreamPromise = modules.bindings.llmStreamCallExecute(
        params.provider,
        request,
        (rawWrapper: unknown) => {
          const wrapper = asRecord(rawWrapper);
          const streamId = wrapper.__nemo_flow_stream_id as number;
          const effective = applyRequestToStreamCall({
            request: wrapper.__nemo_flow_native ?? request,
            context,
            options,
          });
          underlyingStreamPromise = Promise.resolve().then(
            () =>
              params.streamFn(
                model,
                effective.context as Parameters<StreamFn>[1],
                effective.options as Parameters<StreamFn>[2],
              ) as unknown as StreamLike,
          );

          underlyingPumpPromise = (async () => {
            try {
              const source = await underlyingStreamPromise;
              for await (const chunk of source as AsyncIterable<unknown>) {
                const chunkJson =
                  chunk != null && typeof chunk === "object" ? chunk : { value: chunk };
                modules.bindings.pushStreamChunk(streamId, chunkJson);
              }
            } catch (error) {
              underlyingStreamFailed = true;
              underlyingStreamFailure = error;
            } finally {
              modules.bindings.endStream(streamId);
            }
          })();

          return null;
        },
        (chunk) => {
          collectedChunks.push(chunk);
          return null;
        },
        () => buildFinalStreamResponse(collectedChunks),
        null,
        LLM_ATTR_STREAMING,
        null,
        {
          ...(params.runId && { runId: params.runId }),
          ...(params.agentId && { agentId: params.agentId }),
          ...(params.sessionId && { sessionId: params.sessionId }),
          ...(params.sessionKey && { sessionKey: params.sessionKey }),
        },
        params.modelId,
      );

      const throwUnderlyingStreamFailure = () => {
        if (underlyingStreamFailed) {
          throw underlyingStreamFailure;
        }
      };

      let iterated = false;
      let completed = false;
      const consume = async function* () {
        if (iterated) {
          throw new Error("nemo-flow wrapped stream already consumed");
        }
        iterated = true;
        const llmStream = await llmStreamPromise;
        while (true) {
          const chunk = await llmStream.next();
          if (chunk === null) {
            break;
          }
          yield chunk;
        }
        await underlyingPumpPromise;
        throwUnderlyingStreamFailure();
        completed = true;
      };

      return {
        async *[Symbol.asyncIterator]() {
          yield* consume();
        },
        result: async () => {
          throwUnderlyingStreamFailure();
          if (!completed) {
            for await (const chunk of consume()) {
              void chunk;
              // drain stream so NeMo Flow finalizers run before result() resolves
            }
          }
          throwUnderlyingStreamFailure();
          const underlying = await underlyingStreamPromise;
          return await underlying?.result?.();
        },
      } as StreamLike;
    })();

    return {
      async *[Symbol.asyncIterator]() {
        const resolved = await stream;
        yield* resolved;
      },
      result: async () => await (await stream).result?.(),
    } as unknown as ReturnType<StreamFn>;
  }) as StreamFn;

  return wrapped;
}
