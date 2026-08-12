// packages/client/src/index.ts
//
// @agentvalet/client — the non-MCP path onto the AgentValet broker.
//
// If you're inside an MCP host (Claude Code, Claude Desktop, Cursor), install
// @agentvalet/mcp-server instead and call use_platform. This package is for
// agents that aren't MCP: LangChain tools, cron jobs, plain Node services.

export { AgentValet } from "./client.js";
export type { AgentValetOptions, CallRequest } from "./client.js";

export {
  AgentValetError,
  AccessDeniedError,
  ApprovalDeniedError,
  ApprovalExpiredError,
  ApprovalTimeoutError,
  ConfigError,
  NetworkError,
  ProxyError,
  UpstreamError,
} from "./errors.js";

export { DEFAULT_PROXY_URL } from "./env.js";
export type { FetchLike } from "./http.js";
