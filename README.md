# agent-cascade (MCP server)

## Overview
`agent-cascade` bridges Model Context Protocol (MCP) clients to a local language model endpoint (e.g., LM Studio, Ollama-compatible servers). It exposes a single chat-completion tool so you can route requests from Windsurf/Cascade directly to your locally hosted model without relying on hosted APIs.

## Supported capabilities
- `local_chat` MCP tool - forwards prompts to an LM Studio-compatible `/chat/completions` endpoint and returns the response to the client.
- `local.chat` request handler - optional direct method (for clients that support invoking custom MCP methods) with the same semantics as the tool.

### Not included
Autonomous "continue working" loops are **not** part of this package. The earlier documentation referenced `cascade.auto`, but that behaviour lives in a different tool and is not shipped here.

## Environment configuration
| Variable        | Default value              | Purpose                                                 |
|-----------------|----------------------------|---------------------------------------------------------|
| `LM_BASE_URL`   | `http://10.5.0.2:11434/v1` | Base URL for the local LM Studio/Ollama-compatible API. |
| `DEFAULT_MODEL` | `qwen2.5-coder`            | Model used when the caller does not supply one.         |

## Installation & build
```bash
cd tools/agent-cascade
npm install
npm run build
```
This compiles `src/server.ts` into `dist/server.js`, which is the entry point you reference from your MCP client configuration.

## Windsurf/Cascade configuration
1. Open **Cascade panel > Plugins > Manage > View raw config**.
2. Insert (or update) the server block below and save.
3. Refresh the Cascade window so the new server loads.

```json
{
  "mcpServers": {
    "agent-cascade": {
      "command": "node",
      "args": ["\\agent-cascade\\dist\\server.js"],
      "env": {
        "LM_BASE_URL": "http://10.5.0.2:11434/v1",
        "DEFAULT_MODEL": "qwen2.5-coder"
      },
      "disabled": false
    }
  }
}
```

> Tip: For a portable setup, build first and then point to the absolute path of your locally built `dist/server.js`. Some environments do not expand `${workspaceFolder}`.

## Verifying the server
Inside a Cascade chat tab you can sanity-check the setup:
- Run `tools.list` - you should see `local_chat` exposed by `agent-cascade`.
- Call the tool: invoke `local_chat` with `{ "prompt": "Say hello in one short sentence." }` to confirm a response from your local model.
- Optional: call the method `local.chat` with the same payload if your client supports MCP method calls.

If requests fail, confirm that your LM endpoint is reachable at `LM_BASE_URL` and that the selected `DEFAULT_MODEL` exists.

## Troubleshooting
- **Timeouts or empty responses** - increase `timeout_ms` when invoking the tool or ensure the model is loaded in LM Studio.
- **HTTP errors** - the server surfaces the upstream status code and the first 500 characters of the body to highlight configuration issues.
- **Model not found** - either pass the `model` field in the tool call or update `DEFAULT_MODEL` to match a model served by your local endpoint.
