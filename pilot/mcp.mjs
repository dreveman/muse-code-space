// Code Space's MCP server: native tools for agent-to-agent messaging.
//
// muse serve sessions get no native peer messaging (muse 1.4 registers
// session-message targets for TUI sessions only), so the pilot gives every
// session it starts or resumes a per-session MCP server through MSP's
// `config.mcpServers` (transport streamableHttp, URL /mcp/<token>). The
// token identifies the calling agent, so a tool call always knows who's
// sending. Tools: send_message, list_agents.
//
// Minimal streamable-HTTP MCP: POST JSON-RPC, answered with plain JSON
// (no SSE stream; GET is 405), which the spec allows for servers that don't
// push notifications.

// Muse presents these as mcp__code_space__send_message / list_agents.
export const MCP_SERVER_NAME = "code-space";

// Built-in messaging is mandatory. A version/configuration of muse serve
// that does not grant sessionMcp is not a supported Code Space pilot: refuse
// to boot rather than silently creating agents without messaging tools.
export function requireSessionMcp(initializeResult) {
  if (!initializeResult?.grantedCapabilities?.includes("sessionMcp")) {
    throw new Error("Muse serve did not grant sessionMcp. Code Space requires a Muse Code version/configuration that grants per-session MCP (initialize.grantedCapabilities must contain sessionMcp). Update Muse Code before starting the pilot.");
  }
}

export function attachSessionMcp(method, params, baseUrl, mintToken = () => crypto.randomUUID()) {
  if ((method !== "session/start" && method !== "session/resume") || !params || typeof params !== "object") {
    return { params, token: null };
  }
  const token = mintToken();
  const config = sessionMcpConfig(baseUrl, token);
  return {
    params: {
      ...params,
      config: { ...params.config, mcpServers: { ...params.config?.mcpServers, ...config.mcpServers } },
    },
    token,
  };
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const MCP_TOOLS = [
  {
    name: "send_message",
    title: "Message another agent",
    description:
      "Send a message to another Code Space agent or the user's Muse assistant by a name shown in list_agents. " +
      "The recipient gets it as a new turn that says it's from you and how to reply; if it's busy, the message waits for its current turn.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient: an agent or assistant avatar name from list_agents." },
        text: { type: "string", description: "The message." },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agents",
    title: "List agents",
    description: "List the other Code Space agents you can message (and whether each is busy), plus the user's Muse assistant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolText = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/**
 * Handle one JSON-RPC message (or batch) for the agent behind `token`.
 * `deps`: { agentForToken(token) -> entry|undefined, listAgents(entry) -> string,
 *           sendMessage(entry, to, text) -> Promise<{ok, error?, to?, queued?}> }.
 * Returns the response body (object/array) or null for notification-only input.
 */
export async function handleMcpRequest(token, message, deps) {
  if (Array.isArray(message)) {
    const responses = (await Promise.all(message.map((m) => handleMcpRequest(token, m, deps)))).filter(Boolean);
    return responses.length ? responses : null;
  }
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return rpcError(null, -32600, "invalid request");
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  if (isNotification) return null; // notifications/initialized, cancelled, …

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
    return ok(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
      instructions: "Code Space agent messaging: use send_message to message another agent or the user's Muse assistant, list_agents to see who's there.",
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: MCP_TOOLS });
  if (method === "tools/call") {
    const entry = deps.agentForToken(token);
    if (!entry) return ok(id, toolText("This agent isn't known to Code Space anymore (it may have been deleted).", true));
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "list_agents") return ok(id, toolText(deps.listAgents(entry)));
    if (name === "send_message") {
      const to = typeof args.to === "string" ? args.to.trim() : "";
      const text = typeof args.text === "string" ? args.text : "";
      if (!to || !text.trim()) return ok(id, toolText("send_message needs both `to` and `text`.", true));
      const result = await deps.sendMessage(entry, to, text);
      if (!result.ok) return ok(id, toolText(`Not delivered: ${result.error}`, true));
      return ok(id, toolText(`Delivered to ${result.to?.name ?? to}${result.queued ? " (queued behind its current turn)" : ""}.`));
    }
    return rpcError(id, -32602, `unknown tool: ${name}`);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

/** The per-session MCP config injected into session/start and session/resume. */
export function sessionMcpConfig(baseUrl, token) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: { transport: "streamableHttp", url: `${baseUrl}/mcp/${token}`, mode: "required" },
    },
  };
}
