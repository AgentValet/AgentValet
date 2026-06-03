# ── AgentValet MCP server — Glama introspection image ──────────────────────
#
# This image starts the MCP server over stdio with NO credentials. It exists so
# a sandbox (e.g. Glama) can launch the server and introspect it without any
# agent identity:
#
#   • initialize  → succeeds, returns capabilities + instructions
#   • tools/list  → returns the FULL static tool catalogue (every tool's name,
#                   description and inputSchema)
#   • tools/call  → returns a clean, structured "credentials not configured"
#                   tool result (isError: true). The process NEVER exits.
#
# It deliberately ships NO credentials or secrets: no ENV agent id / owner / key,
# and no ARG that takes a key. The default stdio transport is used
# (MCP_TRANSPORT is left unset).
#
# To run as a real agent, pass credentials at runtime instead — AGENT_ID,
# OWNER_ID, and one of AGENT_PRIVATE_KEY_B64 / AGENT_PRIVATE_KEY_PATH /
# AGENT_PRIVATE_KEY (and optionally PROXY_URL). Without them the server stays in
# introspection-only mode by design.

FROM node:20-alpine

# Pin the published package (which carries the credential-less introspection
# behaviour as of 1.1.0) for a small, reproducible image. The bin name comes
# from package.json "bin": agentvalet-mcp-server.
RUN npm install -g @agentvalet/mcp-server@1.1.0

ENTRYPOINT ["agentvalet-mcp-server"]
