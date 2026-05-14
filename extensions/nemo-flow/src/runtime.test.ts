import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNemoFlowPluginConfig } from "./config.js";

type StreamLike = AsyncIterable<unknown> & {
  result?: () => Promise<unknown>;
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("nemo-flow-node");
  vi.doUnmock("nemo-flow-node/plugin");
});

async function importRuntimeWithNemoFlowMocks() {
  const pushedChunks: unknown[] = [];
  let ended = false;
  let wakeConsumer: (() => void) | undefined;

  const wake = () => {
    wakeConsumer?.();
    wakeConsumer = undefined;
  };

  const waitForChunkOrEnd = async () => {
    if (pushedChunks.length > 0 || ended) {
      return;
    }
    await new Promise<void>((resolve) => {
      wakeConsumer = resolve;
    });
  };

  const bindings = {
    createScopeStack: vi.fn(() => ({})),
    setThreadScopeStack: vi.fn(),
    pushScope: vi.fn(() => ({})),
    popScope: vi.fn(),
    toolCallExecuteAsync: vi.fn(),
    llmStreamCallExecute: vi.fn(
      async (_name: unknown, _request: unknown, streamFn: (request: unknown) => unknown) => {
        streamFn({
          __nemo_flow_stream_id: 7,
        });
        return {
          next: vi.fn(async () => {
            await waitForChunkOrEnd();
            return pushedChunks.length > 0 ? pushedChunks.shift() : null;
          }),
        };
      },
    ),
    pushStreamChunk: vi.fn((_streamId: number, chunk: unknown) => {
      pushedChunks.push(chunk);
      wake();
      return true;
    }),
    endStream: vi.fn(() => {
      ended = true;
      wake();
    }),
    ScopeType: {
      Agent: 1,
    },
  };

  vi.doMock("nemo-flow-node", () => bindings);
  vi.doMock("nemo-flow-node/plugin", () => ({
    defaultConfig: vi.fn(() => ({ version: 1, components: [] })),
    validate: vi.fn(() => ({})),
    initialize: vi.fn(async () => ({})),
    clear: vi.fn(),
  }));

  const runtime = await import("./runtime.js");
  return { bindings, runtime };
}

describe("nemo-flow config", () => {
  it("defaults to an empty NeMo Flow plugin-host config", () => {
    expect(resolveNemoFlowPluginConfig(undefined)).toEqual({
      version: 1,
      components: [],
    });
  });

  it("accepts the hoisted plugin-host config shape", () => {
    expect(
      resolveNemoFlowPluginConfig({
        version: 1,
        components: [
          {
            kind: "observability",
            enabled: true,
            config: {
              version: 1,
              endpoint: "http://localhost:4318",
            },
          },
        ],
        policy: {
          unknown_component: "warn",
        },
      }),
    ).toEqual({
      version: 1,
      components: [
        {
          kind: "observability",
          enabled: true,
          config: {
            version: 1,
            endpoint: "http://localhost:4318",
          },
        },
      ],
      policy: {
        unknown_component: "warn",
      },
    });
  });

  it.each([
    "enabled",
    "backend",
    "capture",
    "correlation",
    "plugins",
    "nemoFlow",
    "atif",
    "telemetry",
  ])("rejects old wrapper field %s", (field) => {
    expect(() =>
      resolveNemoFlowPluginConfig({
        version: 1,
        components: [],
        [field]: {},
      }),
    ).toThrow(`config.${field} is no longer supported`);
  });
});

describe("nemo-flow stream wrapping", () => {
  it("propagates provider stream failures during iteration", async () => {
    const failure = new Error("provider stream failed");
    const { bindings, runtime } = await importRuntimeWithNemoFlowMocks();
    const providerResult = vi.fn(async () => "provider result");
    const streamFn = vi.fn(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { delta: "first" };
            throw failure;
          },
          result: providerResult,
        }) as StreamLike,
    );

    const wrapped = runtime.wrapStreamFnWithNemoFlow({
      logger,
      config: { version: 1, components: [] },
      provider: "test-provider",
      modelId: "test-model",
      streamFn: streamFn as never,
    });

    const stream = (wrapped as (...args: unknown[]) => StreamLike)({}, {}, {});
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { delta: "first" },
    });
    await expect(iterator.next()).rejects.toThrow(failure);
    expect(bindings.endStream).toHaveBeenCalledTimes(1);
    expect(providerResult).not.toHaveBeenCalled();
  });

  it("propagates provider stream failures through result draining", async () => {
    const failure = new Error("provider stream failed");
    const { bindings, runtime } = await importRuntimeWithNemoFlowMocks();
    const providerResult = vi.fn(async () => "provider result");
    const streamFn = vi.fn(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { delta: "first" };
            throw failure;
          },
          result: providerResult,
        }) as StreamLike,
    );

    const wrapped = runtime.wrapStreamFnWithNemoFlow({
      logger,
      config: { version: 1, components: [] },
      provider: "test-provider",
      modelId: "test-model",
      streamFn: streamFn as never,
    });

    const stream = (wrapped as (...args: unknown[]) => StreamLike)({}, {}, {});

    await expect(stream.result?.()).rejects.toThrow(failure);
    expect(bindings.endStream).toHaveBeenCalledTimes(1);
    expect(providerResult).not.toHaveBeenCalled();
  });
});
