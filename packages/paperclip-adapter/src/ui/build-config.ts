export function buildConfig(values: Record<string, unknown>): Record<string, unknown> {
  const scopes = values.agentvaletScopes;
  const scopesArray: string[] = Array.isArray(scopes)
    ? (scopes as string[])
    : typeof scopes === "string" && scopes.trim()
    ? scopes.split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];

  return {
    underlyingAdapter: values.underlyingAdapter ?? "claude_local",
    underlyingAdapterConfig: values.underlyingAdapterConfig ?? {},
    agentvaletScopes: scopesArray,
    approvalTimeoutSec: Number(values.approvalTimeoutSec ?? 60),
    tokenTtlSec: Number(values.tokenTtlSec ?? 300),
    registrationTimeoutSec: Number(values.registrationTimeoutSec ?? 120),
  };
}
