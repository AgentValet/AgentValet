export function generateAgentValetSkill(params: {
  proxyUrl: string;
  agentId: string;
}): string {
  return `# AgentValet — Credential Proxy

## What this is

Your platform credentials (Slack, Stripe, Gmail, Airtable, etc.) are
managed by AgentValet. You do NOT call these APIs directly. You call
the AgentValet proxy, which injects the correct credential and forwards
your request.

Your identity token is already injected in your environment as
\`AGENTVALET_AGENT_TOKEN\`. The proxy URL is \`AGENTVALET_PROXY_URL\`.

## How to make a platform API call

Instead of:
\`\`\`
POST https://api.slack.com/api/chat.postMessage
Authorization: Bearer xoxb-real-token
\`\`\`

Do this:
\`\`\`
POST ${params.proxyUrl}/proxy/slack/api/chat.postMessage
Authorization: Bearer $AGENTVALET_AGENT_TOKEN
X-AgentValet-Agent-Id: ${params.agentId}
\`\`\`

The proxy validates your token, checks your scope permissions,
applies rate limits, and forwards the request with the real credential.

## Supported platforms

Query the AgentValet registry for the full list of connected platforms:
\`\`\`
GET ${params.proxyUrl}/v1/agents/${params.agentId}/platforms
Authorization: Bearer $AGENTVALET_AGENT_TOKEN
\`\`\`

## When a call requires human approval

If a scope requires approval (e.g. stripe:charge, mail:send), the
proxy returns:
\`\`\`json
{
  "status": "pending_approval",
  "approval_id": "apr_...",
  "message": "This action requires human approval. Waiting..."
}
\`\`\`

Poll \`GET ${params.proxyUrl}/v1/approvals/{approval_id}\` every 5
seconds until status is "approved" or "denied". If "denied" or timeout
(see AGENTVALET_APPROVAL_TIMEOUT_SEC), abort the action and report
to Paperclip that the task is blocked pending approval.

## What NOT to do

- Never call SaaS platform APIs directly
- Never use hardcoded API keys or tokens
- Never cache the AGENTVALET_AGENT_TOKEN across runs — it expires
- Never expose AGENTVALET_AGENT_TOKEN in task comments or logs
`;
}
