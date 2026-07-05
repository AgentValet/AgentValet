// @agentvalet/mcp-broker
//
// Embeddable credential broker and policy enforcement for third-party MCP
// servers. Wrap a server once; every tool registered afterward is
// policy-checked, credential-injected, and audited. Free and open source; the
// hosted control plane (policy management, push approvals, centralized audit,
// the vault) is the paid layer and speaks the same four interfaces.
export { broker } from "./broker.js";
export type { WrappableServer } from "./broker.js";

export type {
  AccessRequest,
  ApprovalProvider,
  ApprovalResult,
  AuditEvent,
  AuditSink,
  BrokerOptions,
  Credential,
  CredentialRef,
  Decision,
  Effect,
  IdentityResolver,
  McpHandlerExtra,
  Obligation,
  Outcome,
  PolicySource,
  RedactionHook,
  SecretSource,
  ToolContext,
} from "./types.js";

// The pipeline is exported so an author can compose it directly (e.g. for a
// custom transport) without going through broker().
export { runPipeline } from "./pipeline.js";
export type { PipelineDeps, PipelineResult } from "./pipeline.js";

// Local source implementations and the default identity resolver, for direct
// construction and for tests.
export { defaultIdentityResolver } from "./identity.js";
export { FilePolicySource } from "./policy/file-source.js";
export { AuthzenPolicySource, toAuthzenRequest } from "./policy/authzen-source.js";
export { parsePolicy, PolicyParseError } from "./policy/yaml.js";
export type { PolicyDoc, PolicyRuleDoc, RuleEffect } from "./policy/yaml.js";
export { EnvSecretSource, envVarName } from "./secrets/env-source.js";
export { FileSecretSource, decryptSecretsFile } from "./secrets/file-source.js";
export { JsonlAuditSink, MemoryAuditSink } from "./audit/jsonl-sink.js";
export { CliApprovalProvider } from "./approval/cli-provider.js";
export { argsFingerprint, canonicalize } from "./fingerprint.js";
export { resolvePolicySource, resolveSecretSource, resolveAuditSink } from "./sources.js";

// Hosted (agentvalet:) sources and their shared client. The paid layer speaks
// the same four interfaces as the local sources.
export { HostedClient, HostedHttpError, resolveApiUrl, agentIdFromToken, DEFAULT_API_URL } from "./hosted/client.js";
export type { HostedOptions, TokenProvider } from "./hosted/client.js";
export { AgentvaletPolicySource } from "./hosted/policy-source.js";
export { AgentvaletSecretSource } from "./hosted/secret-source.js";
export { AgentvaletAuditSink } from "./hosted/audit-sink.js";
export { AgentvaletApprovalProvider } from "./hosted/approval-provider.js";
export type { HostedApprovalOptions } from "./hosted/approval-provider.js";
