import { RAGSourceMCP } from "./mcp.js";
import { createApp } from "./api.js";
import type { Env } from "./types.js";

// McpAgent als Durable Object exportieren
export { RAGSourceMCP };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // MCP-Endpunkt → McpAgent (Durable Objects)
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return RAGSourceMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // REST-Endpunkte → Hono
    const app = createApp();
    return app.fetch(request, env, ctx);
  },
};
