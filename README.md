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

**Note**: By default, no token limit is imposed on responses. If you need to limit response length, specify `max_tokens` when calling the tool.

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
      "args": ["./dist/server.js"],
      "env": {
        "LM_BASE_URL": "http://10.5.0.2:11434/v1",
        "DEFAULT_MODEL": "qwen2.5-coder"
      },
      "disabled": false,
      "disabledTools": []
    }
  }
}
```

> Tip: For a portable setup, build first and then point to the absolute path of your locally built `dist/server.js`. Some environments do not expand `${workspaceFolder}`.

## Self‑Ask / Reflection (Same‑Model Sub‑Calls)

Yes — you can point this tool at the very same local model the client is using and have it “ask itself.” Nothing special is required on the server side: `agent-cascade` is a thin proxy to your `/chat/completions` endpoint. To keep this safe and predictable, make the reflection a separate, budgeted sub‑call with depth caps and short outputs that you enforce in your orchestrator/agent logic.

- Use small budgets: set `max_tokens` to a low value (e.g., 64–256) and a short `timeout_ms`.
- Keep it concise: pass a `system` prompt that requires terse outputs.
- Control recursion in the caller: enforce a max “reflection depth” in your agent; the server does not loop on its own.

Example sub‑call via MCP tools/call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "local_chat",
    "arguments": {
      "system": "You are a terse reviewer. Reply in <=5 short bullets.",
      "prompt": "Reflect on the draft plan; list obvious risks only.",
      "max_tokens": 128,
      "temperature": 0.1,
      "timeout_ms": 10000
    }
  }
}
```

This snippet is drop‑in and safe: it’s just another call to your local model with a tight budget and constraints. If you’re performing multi‑step workflows, track your own depth/budget in the caller and stop when limits are hit.

## Demo

The screenshot below shows `agent-cascade` in action, successfully routing a chat completion request through Windsurf/Cascade to a local language model:

![Agent Cascade Demo](./Screenshot%202025-09-21%20215159.png)

*Example: The `local_chat` tool responding with "Hello! I'm here and ready to help you with any coding questions or tasks you might have."*

## Troubleshooting
- **Timeouts or empty responses** - increase `timeout_ms` when invoking the tool or ensure the model is loaded in LM Studio.
- **HTTP errors** - the server surfaces the upstream status code and the first 500 characters of the body to highlight configuration issues.
- **Model not found** - either pass the `model` field in the tool call or update `DEFAULT_MODEL` to match a model served by your local endpoint.
