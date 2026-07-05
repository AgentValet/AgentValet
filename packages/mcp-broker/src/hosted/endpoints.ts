// Control-plane paths the hosted sources use, relative to the API base
// (https://api.agentvalet.ai or AGENTVALET_API_URL).
//
// AUTHZEN_ACCESS is live today (apps/proxy/src/routes/authzen.ts). The BROKER_*
// paths are the minimal surface the hosted secret, audit, and approval sources
// need; see the seam note (docs/mcp-broker/open-and-paid-seam.md) for the exact
// server-side reuse each one maps onto, and the credentials-never-in-responses
// decision the secret mint depends on.
//
// The free tier the broker talks to is the /v1/mcp/connect surface: a server
// author with no paid plan reaches hosted policy through the connect entry
// rather than a managed policy document.
export const AUTHZEN_ACCESS = "/v1/authzen/access";
export const MCP_CONNECT = "/v1/mcp/connect";

export const BROKER_CREDENTIAL = "/v1/broker/credential";
export const BROKER_AUDIT = "/v1/broker/audit";
export const BROKER_APPROVALS = "/v1/broker/approvals";
// Decision-only status read for a broker approval. Distinct from
// /v1/approvals/:id, which re-executes an approved action against the platform;
// a broker tool runs in the author's own server, so there is nothing to
// re-execute and this read never triggers it.
export const APPROVAL_STATUS = (id: string) => `/v1/broker/approvals/${encodeURIComponent(id)}`;
