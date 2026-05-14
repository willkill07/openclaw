import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { NEMO_FLOW_PLUGIN_CONFIG_JSON_SCHEMA, resolveNemoFlowPluginConfig } from "./src/config.js";
import {
  executeToolWithNemoFlow,
  initializeNemoFlowGateway,
  shutdownNemoFlowGateway,
  wrapStreamFnWithNemoFlow,
} from "./src/runtime.js";

const nemoFlowConfigSchema = {
  safeParse(value: unknown) {
    try {
      return { success: true, data: resolveNemoFlowPluginConfig(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  },
  jsonSchema: NEMO_FLOW_PLUGIN_CONFIG_JSON_SCHEMA,
  uiHints: {
    components: {
      label: "Components",
      help: "NeMo Flow plugin-host components to activate.",
    },
    policy: {
      label: "Policy",
      help: "Optional NeMo Flow plugin-host validation policy.",
      advanced: true,
    },
  },
};

export default definePluginEntry({
  id: "nemo-flow",
  name: "NeMo Flow",
  description: "Tool and streaming LLM execution wrapping through NeMo Flow plugins.",
  configSchema: nemoFlowConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveNemoFlowPluginConfig(api.pluginConfig);

    api.registerService({
      id: "nemo-flow-runtime",
      async start() {
        await initializeNemoFlowGateway({
          logger: api.logger,
          config,
        });
      },
      async stop() {
        await shutdownNemoFlowGateway({
          logger: api.logger,
        });
      },
    });

    api.registerAgentStreamingLlmMiddleware(
      (ctx) =>
        wrapStreamFnWithNemoFlow({
          logger: api.logger,
          config,
          provider: ctx.provider,
          modelId: ctx.modelId,
          agentId: ctx.agentId,
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          streamFn: ctx.streamFn,
        }),
      { runtimes: ["pi"], priority: 100 },
    );

    api.registerAgentToolCallMiddleware(
      async (ctx) =>
        await executeToolWithNemoFlow({
          logger: api.logger,
          config,
          toolName: ctx.toolName,
          args: ctx.params,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          agentId: ctx.agentId,
          execute: ctx.execute,
        }),
      { runtimes: ["pi"], priority: 100 },
    );
  },
});
