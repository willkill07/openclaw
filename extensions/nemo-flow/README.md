# NeMo Flow

OpenClaw plugin for NeMo Flow plugin-host initialization and execution wrapping.

## Install

```bash
openclaw plugins add @openclaw/nemo-flow
```

## Config

```json
{
  "plugins": {
    "entries": {
      "nemo-flow": {
        "enabled": true,
        "config": {
          "version": 1,
          "components": [
            {
              "kind": "observability",
              "config": {
                "version": 1,
                "otel": {
                  "enabled": true,
                  "endpoint": "http://localhost:4318"
                }
              }
            }
          ]
        }
      }
    }
  }
}
```

## Local Dev

To test against a local checkout of `nemo-flow-node`, build the Node package first and then override the dependency to the local path from the OpenClaw workspace.
