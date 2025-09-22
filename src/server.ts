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
const DEFAULT_MAX_TOKENS = parseInt(process.env.DEFAULT_MAX_TOKENS ?? "16384");
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT_MS ?? "600000"); // 10 minutes for coding workflows

// Request management for coding workflows
interface ActiveRequest {
  id: string;
  controller: AbortController;
  startTime: number;
  model: string;
  prompt: string;
  status: 'pending' | 'processing' | 'streaming' | 'completed' | 'cancelled' | 'error';
  progress?: string;
}

const activeRequests = new Map<string, ActiveRequest>();

// Generate unique request ID
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper function to process streaming responses with progress tracking
async function processStreamingResponse(response: any, requestId?: string): Promise<string> {
  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let tokenCount = 0;

  try {
    while (true) {
      // Check if request was cancelled
      if (requestId && activeRequests.has(requestId)) {
        const request = activeRequests.get(requestId)!;
        if (request.status === 'cancelled') {
          throw new Error('Request was cancelled');
        }
        // Update status to streaming
        request.status = 'streaming';
        request.progress = `Tokens received: ${tokenCount}`;
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            if (requestId && activeRequests.has(requestId)) {
              activeRequests.get(requestId)!.status = 'completed';
            }
            return result;
          }
          
          try {
            const parsed = JSON.parse(data);
            const content = parsed?.choices?.[0]?.delta?.content;
            if (content) {
              result += content;
              tokenCount++;
              
              // Update progress every 50 tokens for coding workflows
              if (requestId && tokenCount % 50 === 0 && activeRequests.has(requestId)) {
                activeRequests.get(requestId)!.progress = `Tokens received: ${tokenCount}, Length: ${result.length} chars`;
              }
            }
          } catch (e) {
            // Skip invalid JSON lines
            continue;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return result;
}

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
    timeout_ms: z.number().int().positive().optional(),
    stream: z.boolean().optional()
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
    description: "Send a chat completion request to an LM Studio-compatible API with request tracking.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        system: { type: "string" },
        prompt: { type: "string" },
        temperature: { type: "number" },
        max_tokens: { type: "number", minimum: 1, maximum: 32768 },
        timeout_ms: { type: "number", minimum: 1000, maximum: 1800000 }, // 30 minutes max for coding
        stream: { type: "boolean" },
        track_request: { type: "boolean", description: "Enable request tracking for status monitoring" }
      },
      required: ["prompt"]
    },
    annotations: {
      title: "Local Chat",
      readOnlyHint: true,
      openWorldHint: true
    }
  },
  {
    name: "chat_status",
    title: "Chat Request Status",
    description: "Check the status of an active chat request.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request ID to check status for" }
      },
      required: ["request_id"]
    },
    annotations: {
      title: "Chat Status",
      readOnlyHint: true
    }
  },
  {
    name: "cancel_chat",
    title: "Cancel Chat Request",
    description: "Cancel an active chat request.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request ID to cancel" }
      },
      required: ["request_id"]
    },
    annotations: {
      title: "Cancel Chat"
    }
  },
  {
    name: "list_active_chats",
    title: "List Active Chat Requests",
    description: "List all currently active chat requests.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    annotations: {
      title: "List Active Chats",
      readOnlyHint: true
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
        max_tokens = DEFAULT_MAX_TOKENS,
        timeout_ms = DEFAULT_TIMEOUT_MS,
        stream = false,
        track_request = false
      } = args as any;

      if (!prompt || typeof prompt !== "string") {
        throw new Error("Invalid arguments: 'prompt' (string) is required");
      }

      // Generate request ID if tracking is enabled
      const requestId = track_request ? generateRequestId() : undefined;
      
      const base = LM_BASE_URL.replace(/\/+$/, "");
      const body = {
        model,
        messages: [
          ...(system ? [{ role: "system" as const, content: system as string }] : []),
          { role: "user" as const, content: prompt as string }
        ],
        temperature,
        max_tokens: max_tokens,
        stream: stream
      };

      const ac = new AbortController();
      
      // Register request if tracking is enabled
      if (requestId) {
        activeRequests.set(requestId, {
          id: requestId,
          controller: ac,
          startTime: Date.now(),
          model,
          prompt: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
          status: 'pending'
        });
      }

      const timeout = setTimeout(() => {
        if (requestId && activeRequests.has(requestId)) {
          activeRequests.get(requestId)!.status = 'cancelled';
        }
        ac.abort();
      }, Number(timeout_ms));

      try {
        if (requestId && activeRequests.has(requestId)) {
          activeRequests.get(requestId)!.status = 'processing';
        }

        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (requestId && activeRequests.has(requestId)) {
            activeRequests.get(requestId)!.status = 'error';
          }
          throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
        }

        let out: string;
        let json: any;
        let responseData: any = {};

        if (stream) {
          // Handle streaming response with progress tracking
          out = await processStreamingResponse(res, requestId);
          json = { choices: [{ message: { content: out } }] };
        } else {
          // Handle non-streaming response
          json = (await res.json()) as any;
          out = json?.choices?.[0]?.message?.content ?? "";
          if (requestId && activeRequests.has(requestId)) {
            activeRequests.get(requestId)!.status = 'completed';
          }
        }

        // Include request ID in response if tracking was enabled
        if (requestId) {
          responseData.request_id = requestId;
          responseData.status = 'completed';
          responseData.duration_ms = Date.now() - activeRequests.get(requestId)!.startTime;
          
          // Clean up completed request after a delay to allow status checks
          setTimeout(() => {
            activeRequests.delete(requestId);
          }, 30000); // Keep for 30 seconds
        }

        return {
          content: [{ type: "text", text: out }],
          structuredContent: { ...json, ...responseData }
        } satisfies z.infer<typeof CallToolResultSchema>;
      } catch (error) {
        if (requestId && activeRequests.has(requestId)) {
          activeRequests.get(requestId)!.status = 'error';
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (name === "chat_status") {
      const { request_id } = args as any;
      
      if (!request_id || typeof request_id !== "string") {
        throw new Error("Invalid arguments: 'request_id' (string) is required");
      }

      const request = activeRequests.get(request_id);
      if (!request) {
        return {
          content: [{ type: "text", text: "Request not found or has expired" }],
          structuredContent: { status: 'not_found', request_id }
        } satisfies z.infer<typeof CallToolResultSchema>;
      }

      const duration = Date.now() - request.startTime;
      return {
        content: [{ type: "text", text: `Request ${request_id}: ${request.status}${request.progress ? ` - ${request.progress}` : ''}` }],
        structuredContent: {
          request_id,
          status: request.status,
          model: request.model,
          duration_ms: duration,
          progress: request.progress,
          prompt_preview: request.prompt
        }
      } satisfies z.infer<typeof CallToolResultSchema>;
    }

    if (name === "cancel_chat") {
      const { request_id } = args as any;
      
      if (!request_id || typeof request_id !== "string") {
        throw new Error("Invalid arguments: 'request_id' (string) is required");
      }

      const request = activeRequests.get(request_id);
      if (!request) {
        return {
          content: [{ type: "text", text: "Request not found or already completed" }],
          structuredContent: { status: 'not_found', request_id }
        } satisfies z.infer<typeof CallToolResultSchema>;
      }

      if (request.status === 'completed' || request.status === 'cancelled') {
        return {
          content: [{ type: "text", text: `Request ${request_id} is already ${request.status}` }],
          structuredContent: { status: request.status, request_id }
        } satisfies z.infer<typeof CallToolResultSchema>;
      }

      // Cancel the request
      request.status = 'cancelled';
      request.controller.abort();

      return {
        content: [{ type: "text", text: `Request ${request_id} has been cancelled` }],
        structuredContent: { status: 'cancelled', request_id }
      } satisfies z.infer<typeof CallToolResultSchema>;
    }

    if (name === "list_active_chats") {
      const activeList = Array.from(activeRequests.values()).map(req => ({
        request_id: req.id,
        status: req.status,
        model: req.model,
        duration_ms: Date.now() - req.startTime,
        progress: req.progress,
        prompt_preview: req.prompt
      }));

      return {
        content: [{ type: "text", text: `Active requests: ${activeList.length}\n${activeList.map(r => `- ${r.request_id}: ${r.status} (${r.duration_ms}ms)`).join('\n')}` }],
        structuredContent: { active_requests: activeList, count: activeList.length }
      } satisfies z.infer<typeof CallToolResultSchema>;
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
        max_tokens = DEFAULT_MAX_TOKENS,
        timeout_ms = DEFAULT_TIMEOUT_MS,
        stream = false
      } = request.params;
      
      const base = LM_BASE_URL.replace(/\/+$/, "");
      const body = {
        model,
        messages: [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          { role: "user" as const, content: prompt }
        ],
        temperature,
        max_tokens: max_tokens,
        stream: stream
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

        let out: string;
        let json: any;

        if (stream) {
          // Handle streaming response
          out = await processStreamingResponse(res);
          json = { choices: [{ message: { content: out } }] };
        } else {
          // Handle non-streaming response
          json = await res.json() as any;
          out = json?.choices?.[0]?.message?.content ?? "";
        }

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
