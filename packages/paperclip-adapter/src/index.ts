export const type = "agentvalet";

const adapter = { type, label: "AgentValet (credential proxy)", models: [] as string[] };
export default adapter;
export const label = "AgentValet (credential proxy)";

// No models — delegates to underlying runtime which has its own model selection
export const models = [];

export const agentConfigurationDoc = `# agentvalet adapter configuration

Use when: You want all platform API calls from this Paperclip agent to
route through AgentValet for identity verification, credential injection,
scope enforcement, rate limiting, human-in-the-loop approvals, and audit
logging.

Don't use when: The agent only does local work (file editing, code
generation) with no SaaS platform calls. In that case, use claude_local
directly.

## Company-level setup (required once per Paperclip instance)

Set these three environment variables in your Paperclip instance before
configuring any agent with this adapter:

  AGENTVALET_PROXY_URL      — AgentValet proxy base URL
                              e.g. https://api.agentvalet.ai
  AGENTVALET_OWNER_ID       — Your AgentValet Owner ID
                              (found in AgentValet Settings)
  AGENTVALET_COMPANY_KEY    — RS256 private key PEM for this company.

  WHERE TO GET IT:
  Recommended: AgentValet → Settings → Integrations → Paperclip → Generate keypair
  AgentValet generates the keypair and shows the private key once.

  Or generate your own with openssl:
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out company.key
  Then set AGENTVALET_COMPANY_KEY to the contents of company.key.
  Register the public key (company.pub) in AgentValet Settings.

  MULTI-LINE HANDLING:
  If your environment mangles newlines, use one of:
    - Escaped: replace newlines with literal \\n in the env var value
    - Base64:  base64-encode the full PEM, set as AGENTVALET_COMPANY_KEY_B64
  The adapter detects and handles all three formats automatically.

  Never use the same key across different Paperclip companies.
  Rotate by generating a new key in AgentValet and updating this var.

These are read from the process environment. Never put them in
adapterConfig.

## Per-agent adapterConfig fields

All fields are optional. The adapter uses company env vars for identity.

- underlyingAdapter: string
    Which Paperclip adapter to delegate execution to.
    Default: "claude_local"
    Options: "claude_local" | "process" | "http"

- underlyingAdapterConfig: object
    Config passed through to the underlying adapter verbatim.
    Must match the underlying adapter's config schema.
    e.g. for claude_local: { "cwd": "/projects/my-agent", "model": "..." }

- agentvaletScopes: string[]
    HINT ONLY — does not grant permissions.
    List of scopes this agent intends to use.
    e.g. ["slack:read", "slack:write", "airtable:read"]
    Pre-populates the AgentValet registration request so the owner
    can see intended access when approving. AgentValet still requires
    owner approval before any scope is active.
    Omit if unknown — owner sets final scopes in AgentValet dashboard.

- approvalTimeoutSec: number
    How long to wait (blocking) for human approval before marking
    the run as blocked.
    Default: 60. Set to 0 for fire-and-forget (no wait).

- tokenTtlSec: number
    Lifetime of the JWT minted per heartbeat run.
    Default: 300 (5 minutes).
    Must be >= timeoutSec of the underlying adapter.

- registrationTimeoutSec: number
    How long to wait for owner approval of a new agent registration
    before giving up and leaving the run as pending.
    Default: 120. The agent will retry on the next heartbeat.
`;
