// Recipient allow-list (domains and exact addresses): the check itself, the policy grammar that feeds
// it, and the pipeline behaviour (hard deny before approval, audit carries
// offending domains only, never full addresses).
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRecipientDomains, emailDomain, type RecipientDomainsObligation } from "../src/recipients.js";
import { parsePolicy, PolicyParseError } from "../src/policy/yaml.js";
import { FilePolicySource } from "../src/policy/file-source.js";
import { runPipeline, type PipelineDeps } from "../src/pipeline.js";
import { MemoryAuditSink } from "../src/audit/jsonl-sink.js";
import { EnvSecretSource } from "../src/secrets/env-source.js";
import { defaultIdentityResolver } from "../src/identity.js";
import type { ApprovalProvider, Decision, PolicySource } from "../src/types.js";

const ob = (args: string[], allowedDomains: string[]): RecipientDomainsObligation => ({
  type: "recipient_domains",
  args,
  allowedDomains,
});
const ACME = ob(["to", "cc", "bcc"], ["acme.com", "partner.io"]);

describe("checkRecipientDomains", () => {
  it("allows when every recipient is at an allowed domain", () => {
    expect(checkRecipientDomains({ to: "a@acme.com", cc: ["b@partner.io"] }, ACME)).toEqual({ ok: true });
  });

  it("denies and names only the offending domain", () => {
    const r = checkRecipientDomains({ to: "a@acme.com", bcc: ["leak@evil.com"] }, ACME);
    expect(r).toEqual({ ok: false, reason: "recipient domain not allowed: evil.com", domains: ["evil.com"] });
  });

  it("does not admit subdomains unless listed", () => {
    expect(checkRecipientDomains({ to: "a@mail.acme.com" }, ACME).ok).toBe(false);
  });

  it("does not admit a lookalike that ends with an allowed domain", () => {
    expect(checkRecipientDomains({ to: "a@notacme.com" }, ACME).ok).toBe(false);
    expect(checkRecipientDomains({ to: "a@acme.com.evil.com" }, ACME).ok).toBe(false);
  });

  it("is case-insensitive and ignores a trailing dot", () => {
    expect(checkRecipientDomains({ to: "A@ACME.COM." }, ACME)).toEqual({ ok: true });
  });

  it("reads display-name addresses and comma/semicolon lists", () => {
    expect(checkRecipientDomains({ to: 'Bob <bob@acme.com>, "Smith, Jo" <jo@partner.io>; c@acme.com' }, ACME)).toEqual({
      ok: true,
    });
    expect(checkRecipientDomains({ to: "Bob <bob@acme.com>, Eve <eve@evil.com>" }, ACME).ok).toBe(false);
  });

  it("takes the domain after the last '@'", () => {
    expect(emailDomain('"a@acme.com"@evil.com')).toBe("evil.com");
    expect(checkRecipientDomains({ to: '"a@acme.com"@evil.com' }, ACME).ok).toBe(false);
  });

  it("normalises unicode domains to IDNA on both sides", () => {
    const r = checkRecipientDomains({ to: "a@bücher.de" }, ob(["to"], ["xn--bcher-kva.de"]));
    expect(r).toEqual({ ok: true });
  });

  it("reads dotted paths into nested args", () => {
    expect(checkRecipientDomains({ message: { to: ["x@acme.com"] } }, ob(["message.to"], ["acme.com"]))).toEqual({
      ok: true,
    });
  });

  it("fails closed when no recipient is found (e.g. a misnamed argument)", () => {
    const r = checkRecipientDomains({ recipient: "x@evil.com" }, ACME);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/no recipients found/);
  });

  it("fails closed on a recipient with no '@'", () => {
    const r = checkRecipientDomains({ to: "everyone" }, ACME);
    expect(r).toEqual({ ok: false, reason: "recipient domain not allowed: (no domain)", domains: ["(no domain)"] });
  });

  it("fails closed on a non-string recipient value", () => {
    expect(checkRecipientDomains({ to: { email: "a@acme.com" } }, ACME).ok).toBe(false);
    expect(checkRecipientDomains({ to: ["a@acme.com", 42] }, ACME).ok).toBe(false);
  });

  it("admits an exact allowed address whose domain is not listed (union with domains)", () => {
    const withAddr: RecipientDomainsObligation = { ...ACME, allowedAddresses: ["ceo@partner-bank.com"] };
    expect(checkRecipientDomains({ to: "a@acme.com", cc: "CEO@Partner-Bank.COM" }, withAddr)).toEqual({ ok: true });
    // Same domain, different mailbox: still denied, and only the domain is reported.
    expect(checkRecipientDomains({ to: "cfo@partner-bank.com" }, withAddr)).toEqual({
      ok: false, reason: "recipient domain not allowed: partner-bank.com", domains: ["partner-bank.com"],
    });
  });

  it("works with addresses only (empty domain list)", () => {
    const addrOnly: RecipientDomainsObligation = { type: "recipient_domains", args: ["to"], allowedDomains: [], allowedAddresses: ["bob@acme.com"] };
    expect(checkRecipientDomains({ to: "Bob <BOB@acme.com>" }, addrOnly)).toEqual({ ok: true });
    expect(checkRecipientDomains({ to: "alice@acme.com" }, addrOnly).ok).toBe(false);
    expect(checkRecipientDomains({ to: "bob" }, addrOnly).ok).toBe(false);
  });

  it("an allowed address does not admit a lookalike built around it", () => {
    const addrOnly: RecipientDomainsObligation = { type: "recipient_domains", args: ["to"], allowedDomains: [], allowedAddresses: ["bob@acme.com"] };
    expect(checkRecipientDomains({ to: '"bob@acme.com"@evil.com' }, addrOnly).ok).toBe(false);
    expect(checkRecipientDomains({ to: "bob@acme.com.evil.com" }, addrOnly).ok).toBe(false);
  });

  it("fails closed on a malformed obligation", () => {
    expect(
      checkRecipientDomains({ to: "a@acme.com" }, { type: "recipient_domains", args: ["to"], allowedDomains: [], allowedAddresses: [] }).ok,
    ).toBe(false);
    expect(checkRecipientDomains({ to: "a@acme.com" }, ob([], ["acme.com"])).ok).toBe(false);
    expect(
      checkRecipientDomains({ to: "a@acme.com" }, { type: "recipient_domains", args: ["to"] } as unknown as RecipientDomainsObligation).ok,
    ).toBe(false);
  });
});

const RULE = (extra: string, effect = "allow") => `version: 1
defaults:
  effect: deny
rules:
  - tool: send_email
    effect: ${effect}
${extra}`;

describe("policy grammar: recipient_args / allowed_domains / allowed_addresses", () => {
  it("parses both keys into a recipients block", () => {
    const doc = parsePolicy(RULE("    recipient_args: to, cc, message.bcc\n    allowed_domains: Acme.com, bücher.de\n"));
    expect(doc.rules[0].recipients).toEqual({
      args: ["to", "cc", "message.bcc"],
      allowedDomains: ["acme.com", "xn--bcher-kva.de"],
    });
  });

  it("requires recipient_args together with at least one allow-list", () => {
    expect(() => parsePolicy(RULE("    recipient_args: to\n"))).toThrow(/needs recipient_args together/);
    expect(() => parsePolicy(RULE("    allowed_domains: acme.com\n"))).toThrow(/needs recipient_args together/);
    expect(() => parsePolicy(RULE("    allowed_addresses: bob@acme.com\n"))).toThrow(/needs recipient_args together/);
  });

  it("parses allowed_addresses, normalised, alone or alongside allowed_domains", () => {
    expect(parsePolicy(RULE("    recipient_args: to\n    allowed_addresses: Bob@Acme.COM, ceo@bücher.de\n")).rules[0].recipients).toEqual({
      args: ["to"], allowedDomains: [], allowedAddresses: ["bob@acme.com", "ceo@xn--bcher-kva.de"],
    });
    expect(parsePolicy(RULE("    recipient_args: to\n    allowed_domains: acme.com\n    allowed_addresses: ceo@partner.io\n")).rules[0].recipients).toEqual({
      args: ["to"], allowedDomains: ["acme.com"], allowedAddresses: ["ceo@partner.io"],
    });
  });

  it("rejects non-addresses and wildcards in allowed_addresses", () => {
    for (const bad of ["acme.com", "@acme.com", "*@acme.com", "bob@", "bob@localhost", "bob smith@acme.com", "<bob@acme.com>"]) {
      expect(() => parsePolicy(RULE(`    recipient_args: to\n    allowed_addresses: ${bad}\n`)), bad).toThrow(PolicyParseError);
    }
  });

  it("rejects allowed_addresses that are duplicates once normalised", () => {
    expect(() => parsePolicy(RULE("    recipient_args: to\n    allowed_addresses: bob@acme.com, BOB@acme.com\n"))).toThrow(/duplicate/);
  });

  it("rejects them on a deny rule", () => {
    expect(() => parsePolicy(RULE("    recipient_args: to\n    allowed_domains: acme.com\n", "deny"))).toThrow(/only apply/);
    expect(() => parsePolicy(RULE("    recipient_args: to\n    allowed_addresses: bob@acme.com\n", "deny"))).toThrow(/only apply/);
  });

  it("rejects wildcards, addresses, and non-domains", () => {
    for (const bad of ["*.acme.com", "bob@acme.com", "localhost", "acme .com"]) {
      expect(() => parsePolicy(RULE(`    recipient_args: to\n    allowed_domains: ${bad}\n`)), bad).toThrow(PolicyParseError);
    }
  });

  it("rejects empty and duplicate list items", () => {
    expect(() => parsePolicy(RULE("    recipient_args: to,\n    allowed_domains: acme.com\n"))).toThrow(/empty item/);
    expect(() => parsePolicy(RULE("    recipient_args: to\n    allowed_domains: acme.com, acme.com\n"))).toThrow(/duplicate/);
  });

  it("rejects flow-list syntax (the grammar stays closed)", () => {
    expect(() => parsePolicy(RULE("    recipient_args: [to]\n    allowed_domains: acme.com\n"))).toThrow(PolicyParseError);
  });

  it("the shipped policy.example.yaml parses, including its send_email rule", () => {
    const doc = parsePolicy(readFileSync(join(__dirname, "..", "policy.example.yaml"), "utf8"));
    expect(doc.rules.find((r) => r.tool === "send_email")?.recipients).toEqual({
      args: ["to", "cc", "bcc"],
      allowedDomains: ["acme.com", "partner.io"],
      allowedAddresses: ["ceo@partner-bank.com"],
    });
  });

  it("the file source attaches the recipient_domains obligation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-broker-rcpt-"));
    const p = join(dir, "policy.yaml");
    writeFileSync(p, RULE("    credential: mail\n    recipient_args: to\n    allowed_domains: acme.com\n"), "utf8");
    const d = await new FilePolicySource(p).evaluate({
      subject: { id: "a", sessionId: "s" },
      action: { name: "send_email" },
      resource: { server: "mail", tool: "send_email" },
      context: { argsFingerprint: "sha256:0", transport: "stdio", ts: "2026-09-25T00:00:00.000Z" },
    });
    expect(d.effect).toBe("allow");
    expect(d.obligations).toEqual([
      { type: "credential", ref: "mail" },
      { type: "recipient_domains", args: ["to"], allowedDomains: ["acme.com"] },
    ]);
  });

  it("the file source passes allowed_addresses through on the obligation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-broker-rcpt-"));
    const p = join(dir, "policy.yaml");
    writeFileSync(p, RULE("    recipient_args: to\n    allowed_addresses: Bob@Acme.com\n"), "utf8");
    const d = await new FilePolicySource(p).evaluate({
      subject: { id: "a", sessionId: "s" },
      action: { name: "send_email" },
      resource: { server: "mail", tool: "send_email" },
      context: { argsFingerprint: "sha256:0", transport: "stdio", ts: "2026-09-26T00:00:00.000Z" },
    });
    expect(d.obligations).toEqual([
      { type: "recipient_domains", args: ["to"], allowedDomains: [], allowedAddresses: ["bob@acme.com"] },
    ]);
  });
});

describe("pipeline enforcement", () => {
  const decision = (effect: Decision["effect"]): Decision => ({
    effect,
    policyId: "custom",
    version: "1",
    obligations: [ob(["to"], ["acme.com"])],
  });

  function deps(policy: PolicySource, audit: MemoryAuditSink, approval?: ApprovalProvider): PipelineDeps {
    return {
      serverName: "mail",
      policy,
      secrets: new EnvSecretSource("", {}),
      audit,
      identity: defaultIdentityResolver,
      failMode: "closed",
      ...(approval ? { approval } : {}),
    };
  }

  it("denies before the handler runs and audits the domain, never the address", async () => {
    const audit = new MemoryAuditSink();
    let ran = false;
    const out = await runPipeline(
      deps({ evaluate: async () => decision("allow") }, audit),
      { toolName: "send_email", args: { to: "secret.person@evil.com" }, extra: {} },
      async () => {
        ran = true;
        return "sent";
      },
    );
    expect(ran).toBe(false);
    expect(out).toEqual({ status: "blocked", effect: "deny", reason: "recipient domain not allowed: evil.com" });
    expect(audit.events).toHaveLength(1);
    const ev = audit.events[0];
    expect(ev.outcome).toBe("denied");
    expect(ev.decision.effect).toBe("deny");
    expect(ev.warnings).toEqual(["recipient_domain_not_allowed: evil.com"]);
    expect(JSON.stringify(ev)).not.toContain("secret.person");
  });

  it("never asks a human to approve a forbidden recipient", async () => {
    const audit = new MemoryAuditSink();
    let asked = false;
    const approval: ApprovalProvider = {
      request: async () => {
        asked = true;
        return { approved: true };
      },
    };
    const out = await runPipeline(
      deps({ evaluate: async () => decision("require_approval") }, audit, approval),
      { toolName: "send_email", args: { to: "x@evil.com" }, extra: {} },
      async () => "sent",
    );
    expect(asked).toBe(false);
    expect(out.status).toBe("blocked");
  });

  it("lets an allowed recipient through to approval and the handler", async () => {
    const audit = new MemoryAuditSink();
    let asked = false;
    const approval: ApprovalProvider = {
      request: async () => {
        asked = true;
        return { approved: true };
      },
    };
    const out = await runPipeline(
      deps({ evaluate: async () => decision("require_approval") }, audit, approval),
      { toolName: "send_email", args: { to: "x@acme.com" }, extra: {} },
      async () => "sent",
    );
    expect(asked).toBe(true);
    expect(out).toEqual({ status: "ok", result: "sent" });
    expect(audit.events[0].outcome).toBe("allowed");
  });
});
