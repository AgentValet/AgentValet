import { describe, it, expect } from "vitest";
import { parsePolicy, PolicyParseError } from "../src/policy/yaml.js";

describe("policy YAML parser", () => {
  it("parses the documented shape", () => {
    const doc = parsePolicy(`version: 1
defaults:
  effect: deny
rules:
  - tool: create_issue
    effect: allow
    credential: github_issues_rw
  - tool: delete_repo
    effect: require_approval
    credential: github_admin
`);
    expect(doc.version).toBe(1);
    expect(doc.defaults.effect).toBe("deny");
    expect(doc.rules).toEqual([
      { tool: "create_issue", effect: "allow", credential: "github_issues_rw" },
      { tool: "delete_repo", effect: "require_approval", credential: "github_admin" },
    ]);
  });

  it("defaults effect to deny when the block is omitted", () => {
    expect(parsePolicy("version: 1\nrules:\n  - tool: a\n    effect: allow\n").defaults.effect).toBe("deny");
  });

  it("preserves a '#' inside a quoted value but strips real comments", () => {
    const doc = parsePolicy(`version: 1  # trailing
rules:
  - tool: "a#b"   # comment
    effect: allow
`);
    expect(doc.rules[0].tool).toBe("a#b");
  });

  const rejects: Array<[string, string]> = [
    ["tabs", "version: 1\nrules:\n\t- tool: a\n"],
    ["anchors", "version: 1\ndefaults: &d\n  effect: deny\n"],
    ["interpolation", "version: 1\nrules:\n  - tool: ${EVIL}\n    effect: allow\n"],
    ["flow collections", "version: 1\nrules: [a, b]\n"],
    ["unknown top-level key", "version: 1\nenvironments:\n  prod: {}\n"],
    ["unknown rule key", "version: 1\nrules:\n  - tool: a\n    effect: allow\n    team: red\n"],
    ["bad effect", "version: 1\nrules:\n  - tool: a\n    effect: maybe\n"],
    ["missing version", "rules:\n  - tool: a\n    effect: allow\n"],
    ["unsupported version", "version: 2\nrules: \n"],
    ["duplicate tool", "version: 1\nrules:\n  - tool: a\n    effect: allow\n  - tool: a\n    effect: deny\n"],
    ["rule without tool", "version: 1\nrules:\n  - effect: allow\n"],
  ];
  for (const [label, src] of rejects) {
    it(`rejects ${label} with a PolicyParseError`, () => {
      expect(() => parsePolicy(src)).toThrow(PolicyParseError);
    });
  }
});

// ---------------------------------------------------------------------------
// Fuzz target: the parser must be TOTAL. For any input it either returns a
// well-formed PolicyDoc or throws PolicyParseError; it must never throw any
// other error type and never hang. Seeded so CI runs the identical cases.
// ---------------------------------------------------------------------------
describe("policy YAML parser fuzz", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
  }
  const FRAGMENTS = [
    "version: 1", "version: 2", "version: x", "defaults:", "  effect: deny", "  effect: allow",
    "  effect: maybe", "rules:", "  - tool: a", "  - tool: b", "    effect: allow",
    "    effect: deny", "    effect: require_approval", "    credential: c", "  - tool: a",
    "\t- tool: t", "  - ${x}", "rules: [x]", "unknown: 1", "  - tool:", '  - tool: "q#q"',
    "# comment", "", "   ", "-", "  -", "::::", 'a: "unterminated', "&anchor", "  <<: *x",
  ];

  it("never throws a non-PolicyParseError over 3000 seeded inputs", () => {
    const rnd = lcg(0x5eed_1234);
    for (let i = 0; i < 3000; i++) {
      const lines = Math.floor(rnd() * 8);
      const src = Array.from({ length: lines }, () => FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)]).join("\n");
      try {
        const doc = parsePolicy(src);
        expect(doc.version).toBe(1);
        expect(Array.isArray(doc.rules)).toBe(true);
        expect(["allow", "deny"]).toContain(doc.defaults.effect);
      } catch (err) {
        expect(err, `input:\n${src}`).toBeInstanceOf(PolicyParseError);
      }
    }
  });

  it("never throws a non-PolicyParseError over random byte strings", () => {
    const rnd = lcg(0xabcd_0001);
    for (let i = 0; i < 1500; i++) {
      const len = Math.floor(rnd() * 60);
      const src = Array.from({ length: len }, () => String.fromCharCode(Math.floor(rnd() * 128))).join("");
      try {
        parsePolicy(src);
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyParseError);
      }
    }
  });
});
