// Deterministic argument fingerprint. The audit trail records this, never the
// raw arguments, so a tool call can be correlated and de-duplicated without the
// payload ever landing in a log. Same args in, same fingerprint out, across
// processes and key orderings.
import { createHash } from "node:crypto";

// Canonical JSON: object keys sorted at every depth so { a, b } and { b, a }
// fingerprint identically. Arrays keep order. Non-JSON values (undefined,
// functions, bigint, circular) are handled defensively rather than thrown, so
// the fingerprint path can never crash a tool call.
export function canonicalize(value: unknown, seen = new Set<unknown>()): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : '"__nonfinite__"';
  if (t === "boolean") return (value as boolean) ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify(`${(value as bigint).toString()}n`);
  if (t === "undefined" || t === "function" || t === "symbol") return '"__unserializable__"';
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v, seen)).join(",")}]`;
  }
  if (t === "object") {
    if (seen.has(value)) return '"__circular__"';
    seen.add(value);
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k], seen)}`).join(",");
    seen.delete(value);
    return `{${body}}`;
  }
  return '"__unserializable__"';
}

export function argsFingerprint(args: unknown): string {
  const canon = canonicalize(args ?? {});
  return `sha256:${createHash("sha256").update(canon).digest("hex")}`;
}
