// A purpose-built parser for the local policy format and nothing else.
//
// The format is deliberately fleet-hostile (A5): one file, per-tool rules, no
// inheritance, no templating, no environments, no anchors. Because the grammar
// is tiny and closed, the broker carries its own small parser rather than a
// general YAML dependency. That keeps the runtime-dependency count at zero and
// gives a small, total function to fuzz. The parser REJECTS anything outside
// the grammar instead of best-effort guessing, so a fleet feature can never be
// smuggled in by accident.
//
// Grammar:
//   version: 1
//   defaults:
//     effect: allow | deny
//   rules:
//     - tool: <name>
//       effect: allow | deny | require_approval
//       credential: <name>            # optional
//       recipient_args: <arg>, <arg>    # optional; needs allowed_domains and/or allowed_addresses
//       allowed_domains: <d>, <d>       # optional, needs recipient_args
//       allowed_addresses: <a>, <a>     # optional, needs recipient_args; exact addresses
//
// Whitespace is spaces only. Tabs, anchors (&), aliases (*), merge keys (<<),
// interpolation (${), and flow collections ([ ]/{ }) are hard errors.

import { normaliseAddress, normaliseDomain } from "../recipients.js";

export type RuleEffect = "allow" | "deny" | "require_approval";

export interface PolicyRuleDoc {
  tool: string;
  effect: RuleEffect;
  credential?: string;
  // Recipient allow-list: args plus at least one of domains / addresses (a union).
  recipients?: { args: string[]; allowedDomains: string[]; allowedAddresses?: string[] };
}

export interface PolicyDoc {
  version: number;
  defaults: { effect: "allow" | "deny" };
  rules: PolicyRuleDoc[];
}

export class PolicyParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`policy parse error (line ${line}): ${message}`);
    this.name = "PolicyParseError";
  }
}

const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\t/, why: "tabs are not allowed; indent with spaces" },
  { re: /(^|\s)[&*]\S/, why: "anchors and aliases are not allowed" },
  { re: /<<\s*:/, why: "merge keys are not allowed" },
  { re: /\$\{/, why: "interpolation is not allowed" },
  { re: /:\s*[[{]/, why: "flow collections are not allowed" },
];

const RULE_EFFECTS: readonly RuleEffect[] = ["allow", "deny", "require_approval"];

// Strip a trailing unquoted comment. A '#' inside a quoted scalar is preserved.
function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(raw[i - 1])) return raw.slice(0, i);
    }
  }
  return raw;
}

function unquote(value: string, line: number): string {
  const v = value.trim();
  if (v === "") throw new PolicyParseError("empty value", line);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    if (v.length < 2) throw new PolicyParseError("unterminated quote", line);
    return v.slice(1, -1);
  }
  if (v.includes('"') || v.includes("'")) {
    throw new PolicyParseError("stray quote in unquoted scalar", line);
  }
  return v;
}

function indentOf(raw: string): number {
  let n = 0;
  while (n < raw.length && raw[n] === " ") n++;
  return n;
}

function splitKeyValue(body: string, line: number): { key: string; value: string } {
  const idx = body.indexOf(":");
  if (idx < 0) throw new PolicyParseError(`expected "key: value", got "${body.trim()}"`, line);
  return { key: body.slice(0, idx).trim(), value: body.slice(idx + 1).trim() };
}

interface DraftRule {
  tool?: string;
  effect: RuleEffect;
  credential?: string;
  recipientArgs?: string[];
  allowedDomains?: string[];
  allowedAddresses?: string[];
  indent: number;
  line: number;
}

// "a, b, c" -> ["a", "b", "c"]. Empty items and duplicates are errors, not
// silently dropped, so a typo cannot quietly shrink or widen a list.
function commaList(value: string, key: string, line: number): string[] {
  const items = value.split(",").map((s) => s.trim());
  if (items.some((s) => s === "")) throw new PolicyParseError(`${key} has an empty item`, line);
  if (new Set(items).size !== items.length) throw new PolicyParseError(`${key} has a duplicate item`, line);
  return items;
}

const ARG_PATH = /^[A-Za-z_$][\w$-]*(\.[A-Za-z_$][\w$-]*)*$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function applyRuleField(rule: DraftRule, body: string, line: number): void {
  const { key, value } = splitKeyValue(body, line);
  const v = unquote(value, line);
  if (key === "tool") {
    rule.tool = v;
  } else if (key === "effect") {
    if (!RULE_EFFECTS.includes(v as RuleEffect)) {
      throw new PolicyParseError(`effect must be one of ${RULE_EFFECTS.join(", ")}`, line);
    }
    rule.effect = v as RuleEffect;
  } else if (key === "credential") {
    rule.credential = v;
  } else if (key === "recipient_args") {
    const args = commaList(v, key, line);
    for (const a of args) {
      if (!ARG_PATH.test(a)) throw new PolicyParseError(`recipient_args: "${a}" is not an argument name or dotted path`, line);
    }
    rule.recipientArgs = args;
  } else if (key === "allowed_domains") {
    const domains = commaList(v, key, line);
    for (const d of domains) {
      // Wildcards are rejected rather than half-supported: subdomains must be
      // listed one by one, the same as the hosted plane. Unicode domains are
      // accepted and stored in their IDNA (punycode) form.
      if (d.includes("@") || !DOMAIN.test(normaliseDomain(d))) {
        throw new PolicyParseError(`allowed_domains: "${d}" is not a domain (no wildcards, no '@')`, line);
      }
    }
    rule.allowedDomains = domains.map(normaliseDomain);
  } else if (key === "allowed_addresses") {
    const addresses = commaList(v, key, line);
    for (const a of addresses) {
      // One exact mailbox: a non-empty local part with no spaces or angle
      // brackets, and a real domain after the last '@'. No wildcards.
      const at = a.lastIndexOf("@");
      const local = at > 0 ? a.slice(0, at) : "";
      if (!local || /[\s<>*]/.test(local) || !DOMAIN.test(normaliseDomain(a.slice(at + 1)))) {
        throw new PolicyParseError(`allowed_addresses: "${a}" is not an email address (no wildcards)`, line);
      }
    }
    const normalised = addresses.map(normaliseAddress);
    if (new Set(normalised).size !== normalised.length) throw new PolicyParseError(`${key} has a duplicate item`, line);
    rule.allowedAddresses = normalised;
  } else {
    throw new PolicyParseError(`unknown rule key "${key}"`, line);
  }
}

export function parsePolicy(source: string): PolicyDoc {
  if (typeof source !== "string") throw new PolicyParseError("source must be a string", 0);
  const lines = source.split(/\r?\n/);

  let version: number | undefined;
  let defaultsEffect: "allow" | "deny" | undefined;
  const drafts: DraftRule[] = [];

  type Section = "top" | "defaults" | "rules";
  let section: Section = "top";
  let current: DraftRule | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = stripComment(lines[i]);
    if (raw.trim() === "") continue;

    for (const f of FORBIDDEN) {
      if (f.re.test(raw)) throw new PolicyParseError(f.why, lineNo);
    }

    const indent = indentOf(raw);
    const body = raw.slice(indent);

    if (indent === 0) {
      current = null;
      const { key, value } = splitKeyValue(body, lineNo);
      if (key === "version") {
        if (!/^\d+$/.test(value)) throw new PolicyParseError("version must be a non-negative integer", lineNo);
        version = Number(value);
        section = "top";
      } else if (key === "defaults") {
        if (value !== "") throw new PolicyParseError('"defaults:" takes no inline value', lineNo);
        section = "defaults";
      } else if (key === "rules") {
        if (value !== "") throw new PolicyParseError('"rules:" takes no inline value', lineNo);
        section = "rules";
      } else {
        throw new PolicyParseError(`unknown top-level key "${key}"`, lineNo);
      }
      continue;
    }

    if (section === "defaults") {
      const { key, value } = splitKeyValue(body, lineNo);
      if (key !== "effect") throw new PolicyParseError(`unknown defaults key "${key}"`, lineNo);
      const v = unquote(value, lineNo);
      if (v !== "allow" && v !== "deny") throw new PolicyParseError('defaults.effect must be "allow" or "deny"', lineNo);
      defaultsEffect = v;
      continue;
    }

    if (section === "rules") {
      if (body === "-" || body.startsWith("- ")) {
        current = { effect: "deny", indent, line: lineNo };
        drafts.push(current);
        const after = body.slice(1).trim();
        if (after !== "") applyRuleField(current, after, lineNo);
        continue;
      }
      if (current == null) {
        throw new PolicyParseError('expected a "- tool:" list item under "rules:"', lineNo);
      }
      if (indent <= current.indent) {
        throw new PolicyParseError("rule field must be indented past its list item", lineNo);
      }
      applyRuleField(current, body, lineNo);
      continue;
    }

    throw new PolicyParseError("unexpected indented content at top level", lineNo);
  }

  if (version === undefined) throw new PolicyParseError('missing required "version"', 0);
  if (version !== 1) {
    throw new PolicyParseError(`unsupported policy version ${version}; only version 1 is supported`, 0);
  }

  const rules: PolicyRuleDoc[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    if (d.tool === undefined || d.tool === "") throw new PolicyParseError('rule is missing "tool:"', 0);
    if (seen.has(d.tool)) throw new PolicyParseError(`duplicate rule for tool "${d.tool}"`, 0);
    seen.add(d.tool);
    const hasAllowList = d.allowedDomains !== undefined || d.allowedAddresses !== undefined;
    if ((d.recipientArgs !== undefined) !== hasAllowList) {
      throw new PolicyParseError(`rule for "${d.tool}" needs recipient_args together with allowed_domains and/or allowed_addresses`, d.line);
    }
    if (d.recipientArgs && d.effect === "deny") {
      throw new PolicyParseError(`rule for "${d.tool}" is deny; recipient_args, allowed_domains and allowed_addresses only apply to allow or require_approval`, d.line);
    }
    const rule: PolicyRuleDoc = { tool: d.tool, effect: d.effect };
    if (d.credential !== undefined) rule.credential = d.credential;
    if (d.recipientArgs && hasAllowList) {
      rule.recipients = { args: d.recipientArgs, allowedDomains: d.allowedDomains ?? [] };
      if (d.allowedAddresses) rule.recipients.allowedAddresses = d.allowedAddresses;
    }
    rules.push(rule);
  }

  return {
    version,
    defaults: { effect: defaultsEffect ?? "deny" },
    rules,
  };
}
