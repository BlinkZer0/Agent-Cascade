# agent-cascade (MCP server)

Tools:
- `cascade.auto(goal, ...)`  → signal host to continue autonomous loop
- `local.chat({ model?, system?, prompt, ... })`  → call local LLM at LM_BASE_URL

Env:
- `LM_BASE_URL`  (default: http://10.5.0.2:11434/v1)
- `DEFAULT_MODEL`  (default: qwen2.5-coder)

Build:
```bash
cd tools/agent-cascade
npm i
npm run build
```

Enable in Windsurf:
Cascade panel → Plugins → Manage → View raw config
Paste the config block from this Ask (below) and Save → Refresh.

## Config Snippet

```json
{
  "mcpServers": {
    "agent-cascade": {
      "command": "node",
      "args": ["C:\\!APPS\\Windsurf\\tools\\agent-cascade\\dist\\server.js"],
      "env": {
        "LM_BASE_URL": "http://10.5.0.2:11434/v1",
        "DEFAULT_MODEL": "qwen2.5-coder"
      },
      "disabled": false
    }
  }
}
```

Note: If you prefer a portable path, build first, then point to your absolute path to `dist/server.js`. Some environments do not expand `${workspaceFolder}`.

## Smoke tests (inside Cascade chat)

1. `tools.list` should show agent-cascade with cascade.auto and local.chat.
2. Call:
   - `local.chat({ prompt: "Say hello in one short sentence." })` → returns text.
   - `cascade.auto({ goal: "keep working" })` → { "ok": true }.
