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
#
# Why build from source instead of `npm i -g @agentvalet/mcp-server@<ver>`:
# the credential-less introspection behaviour is newer than the currently
# published npm release, so pinning to the published package would reintroduce
# the old "exit on missing credentials" startup and break introspection. Once a
# release carrying this change is published, swapping to a pinned global install
# yields an equivalent, smaller image.

# ---- build stage: compile TypeScript -> dist/ ----
FROM node:20-alpine AS build
WORKDIR /app
# Dependency manifests first for layer caching. devDependencies (typescript,
# tsx) are needed here to run `npm run build` (tsc).
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build

# ---- runtime stage: prod deps + compiled output only ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist

# bin name is taken from package.json "bin": agentvalet-mcp-server -> dist/index.js
ENTRYPOINT ["node", "dist/index.js"]
