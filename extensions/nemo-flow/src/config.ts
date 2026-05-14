export type NemoFlowPluginComponentConfig = Record<string, unknown>;

export type NemoFlowPluginComponent = {
  kind: string;
  enabled?: boolean;
  config?: NemoFlowPluginComponentConfig;
};

export type NemoFlowPluginPolicy = {
  unknown_component?: "ignore" | "warn" | "error";
  unknown_field?: "ignore" | "warn" | "error";
  unsupported_value?: "ignore" | "warn" | "error";
};

export type NemoFlowPluginConfig = {
  version: 1;
  components: NemoFlowPluginComponent[];
  policy?: NemoFlowPluginPolicy;
};

const UNSUPPORTED_WRAPPER_FIELDS = new Set([
  "enabled",
  "backend",
  "capture",
  "correlation",
  "plugins",
  "nemoFlow",
  "atif",
  "telemetry",
]);

export const DEFAULT_NEMO_FLOW_PLUGIN_CONFIG: NemoFlowPluginConfig = {
  version: 1,
  components: [],
};

export const NEMO_FLOW_PLUGIN_CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "components"],
  properties: {
    version: {
      type: "number",
      enum: [1],
    },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string", minLength: 1 },
          enabled: { type: "boolean" },
          config: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        unknown_component: {
          type: "string",
          enum: ["ignore", "warn", "error"],
        },
        unknown_field: {
          type: "string",
          enum: ["ignore", "warn", "error"],
        },
        unsupported_value: {
          type: "string",
          enum: ["ignore", "warn", "error"],
        },
      },
    },
  },
} as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnsupportedWrapperFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (UNSUPPORTED_WRAPPER_FIELDS.has(key)) {
      throw new Error(
        `nemo-flow config.${key} is no longer supported; configure NeMo Flow components at the plugin config root`,
      );
    }
  }
}

function validatePolicy(value: unknown): NemoFlowPluginPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  const policy = asRecord(value, "policy");
  const normalized: NemoFlowPluginPolicy = {};
  for (const key of Object.keys(policy)) {
    if (key !== "unknown_component" && key !== "unknown_field" && key !== "unsupported_value") {
      throw new Error(`policy.${key} is not supported`);
    }
    const raw = policy[key];
    if (raw !== "ignore" && raw !== "warn" && raw !== "error") {
      throw new Error(`policy.${key} must be one of ignore, warn, or error`);
    }
    normalized[key] = raw;
  }
  return normalized;
}

function validateComponents(value: unknown): NemoFlowPluginComponent[] {
  if (!Array.isArray(value)) {
    throw new Error("components must be an array");
  }
  return value.map((rawComponent, index) => {
    const component = asRecord(rawComponent, `components[${index}]`);
    for (const key of Object.keys(component)) {
      if (key !== "kind" && key !== "enabled" && key !== "config") {
        throw new Error(`components[${index}].${key} is not supported`);
      }
    }
    if (typeof component.kind !== "string" || component.kind.trim().length === 0) {
      throw new Error(`components[${index}].kind must be a non-empty string`);
    }
    if (component.enabled !== undefined && typeof component.enabled !== "boolean") {
      throw new Error(`components[${index}].enabled must be a boolean`);
    }
    const config =
      component.config === undefined
        ? undefined
        : asRecord(component.config, `components[${index}].config`);
    return {
      kind: component.kind.trim(),
      ...(component.enabled !== undefined ? { enabled: component.enabled } : {}),
      ...(config ? { config } : {}),
    };
  });
}

export function resolveNemoFlowPluginConfig(value: unknown): NemoFlowPluginConfig {
  if (value === undefined || value === null) {
    return { ...DEFAULT_NEMO_FLOW_PLUGIN_CONFIG, components: [] };
  }

  const record = asRecord(value, "nemo-flow config");
  rejectUnsupportedWrapperFields(record);

  for (const key of Object.keys(record)) {
    if (key !== "version" && key !== "components" && key !== "policy") {
      throw new Error(`nemo-flow config.${key} is not supported`);
    }
  }

  if (record.version !== 1) {
    throw new Error("version must be 1");
  }

  return {
    version: 1,
    components: validateComponents(record.components),
    ...(record.policy !== undefined ? { policy: validatePolicy(record.policy) } : {}),
  };
}
