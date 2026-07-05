// Resolves the string shorthands in BrokerOptions ("file:./policy.yaml",
// "env:", "jsonl:./audit.log", ...) into concrete interface implementations. A
// caller who passes an implementation object directly is returned it unchanged,
// so every escape hatch stays open.
import type { AuditSink, PolicySource, SecretSource } from "./types.js";
import { FilePolicySource } from "./policy/file-source.js";
import { AuthzenPolicySource } from "./policy/authzen-source.js";
import { EnvSecretSource } from "./secrets/env-source.js";
import { FileSecretSource } from "./secrets/file-source.js";
import { JsonlAuditSink } from "./audit/jsonl-sink.js";
import { AgentvaletPolicySource } from "./hosted/policy-source.js";
import { AgentvaletSecretSource } from "./hosted/secret-source.js";
import { AgentvaletAuditSink } from "./hosted/audit-sink.js";

function splitScheme(spec: string): { scheme: string; rest: string } {
  const idx = spec.indexOf(":");
  if (idx < 0) throw new Error(`invalid source spec "${spec}" (expected "<scheme>:<locator>")`);
  return { scheme: spec.slice(0, idx), rest: spec.slice(idx + 1) };
}

export function resolvePolicySource(spec: PolicySource | string): PolicySource {
  if (typeof spec !== "string") return spec;
  const { scheme, rest } = splitScheme(spec);
  switch (scheme) {
    case "file":
      return new FilePolicySource(rest);
    case "authzen":
      return new AuthzenPolicySource(rest);
    case "agentvalet":
      // Config (api url, token) comes from the environment; pass { apiUrl } /
      // { token } via a constructed source directly for anything more specific.
      return new AgentvaletPolicySource(rest ? { apiUrl: rest } : {});
    default:
      throw new Error(`unknown policy scheme "${scheme}:"`);
  }
}

export function resolveSecretSource(spec: SecretSource | string): SecretSource {
  if (typeof spec !== "string") return spec;
  const { scheme, rest } = splitScheme(spec);
  switch (scheme) {
    case "env":
      return new EnvSecretSource(rest);
    case "file":
      return new FileSecretSource(rest);
    case "agentvalet":
      return new AgentvaletSecretSource(rest ? { apiUrl: rest } : {});
    case "vaultref":
      // User-owned vault (A4) is a separate, later capability.
      throw new Error("vaultref: (user-owned vault) is not available in this build");
    default:
      throw new Error(`unknown secrets scheme "${scheme}:"`);
  }
}

export function resolveAuditSink(spec: AuditSink | string | undefined): AuditSink {
  if (spec === undefined) return new JsonlAuditSink("./audit.log");
  if (typeof spec !== "string") return spec;
  const { scheme, rest } = splitScheme(spec);
  switch (scheme) {
    case "jsonl":
      return new JsonlAuditSink(rest);
    case "agentvalet":
      return new AgentvaletAuditSink(rest ? { apiUrl: rest } : {});
    case "otel":
      throw new Error("otel: audit sink is not implemented in this build");
    default:
      throw new Error(`unknown audit scheme "${scheme}:"`);
  }
}
