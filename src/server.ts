import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetch } from "undici";
import {
  ListToolsRequestSchema,
  ListToolsResultSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  ToolSchema
} from "@modelcontextprotocol/sdk/types.js";

// Environment variables with defaults
const LM_BASE_URL = process.env.LM_BASE_URL ?? "http://10.5.0.2:11434/v1";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "qwen2.5-coder";

// Define schemas for our custom methods
const AutoRequestSchema = z.object({
  method: z.literal("cascade.auto"),
  params: z.object({
    goal: z.string()
  })
});

const ChatRequestSchema = z.object({
  method: z.literal("local.chat"),
  params: z.object({
    model: z.string().optional(),
    system: z.string().optional(),
    prompt: z.string(),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional()
  })
});

// Create MCP server with required capabilities
const server = new Server(
  {
    name: "agent-cascade",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {
        listChanged: true
      },
      logging: {}
    }
  }
);

// Define tools registry exposing "local_chat" as an MCP tool
const tools = [
  {
    name: "local_chat",
    title: "Local Chat (LM Studio)",
    description: "Send a chat completion request to an LM Studio-compatible API.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        system: { type: "string" },
        prompt: { type: "string" },
        temperature: { type: "number" },
        max_tokens: { type: "number" },
        timeout_ms: { type: "number" }
      },
      required: ["prompt"]
    },
    annotations: {
      title: "Local Chat",
      readOnlyHint: true,
      openWorldHint: true
    }
  }
] satisfies Array<z.infer<typeof ToolSchema>>;

// tools/list handler
server.setRequestHandler(
  ListToolsRequestSchema,
  async () => {
    return { tools } satisfies z.infer<typeof ListToolsResultSchema>;
  }
);

// tools/call handler
server.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {
    const name = request.params?.name;
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

    if (name === "local_chat") {
      const {
        model = DEFAULT_MODEL,
        system,
        prompt,
        temperature = 0.2,
        max_tokens = 1024,
        timeout_ms = 60000
      } = args as any;

      if (!prompt || typeof prompt !== "string") {
        throw new Error("Invalid arguments: 'prompt' (string) is required");
      }

      const base = LM_BASE_URL.replace(/\/+$/, "");
      const body = {
        model,
        messages: [
          ...(system ? [{ role: "system" as const, content: system as string }] : []),
          { role: "user" as const, content: prompt as string }
        ],
        temperature,
        max_tokens,
        stream: false
      };

      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), Number(timeout_ms));
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
        }

        const json = (await res.json()) as any;
        const out = json?.choices?.[0]?.message?.content ?? "";
        return {
          content: [{ type: "text", text: out }],
          structuredContent: json
        } satisfies z.infer<typeof CallToolResultSchema>;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  }
);

// Register cascade.auto handler
server.setRequestHandler(
  AutoRequestSchema,
  async (request) => {
    try {
      if (!request.params.goal) {
        throw new Error("Goal is required");
      }
      return { ok: true };
    } catch (error) {
      console.error("Error in cascade.auto:", error);
      throw error;
    }
  }
);

// Register local.chat handler
server.setRequestHandler(
  ChatRequestSchema,
  async (request) => {
    try {
      const { 
        model = DEFAULT_MODEL,
        system,
        prompt,
        temperature = 0.2,
        max_tokens = 1024,
        timeout_ms = 60000
      } = request.params;
      
      const base = LM_BASE_URL.replace(/\/+$/, "");
      const body = {
        model,
        messages: [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          { role: "user" as const, content: prompt }
        ],
        temperature,
        max_tokens,
        stream: false
      };

      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), timeout_ms);

      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
        }

        const json = await res.json() as any;
        const out = json?.choices?.[0]?.message?.content ?? "";
        return { text: out, raw: json };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      console.error("Error in local.chat:", error);
      throw error;
    }
  }
);

// Start the MCP server
const transport = new StdioServerTransport();
server.connect(transport);

// Keep process alive
process.stdin.resume();
