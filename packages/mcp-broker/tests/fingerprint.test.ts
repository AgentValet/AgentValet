import { describe, it, expect } from "vitest";
import { argsFingerprint, canonicalize } from "../src/fingerprint.js";

const FP = /^sha256:[0-9a-f]{64}$/;

describe("argsFingerprint", () => {
  it("is deterministic and independent of key order", () => {
    expect(argsFingerprint({ a: 1, b: 2 })).toBe(argsFingerprint({ b: 2, a: 1 }));
    expect(argsFingerprint({ a: 1, b: 2 })).toMatch(FP);
  });

  it("distinguishes different arguments", () => {
    expect(argsFingerprint({ a: 1 })).not.toBe(argsFingerprint({ a: 2 }));
    expect(argsFingerprint([1, 2])).not.toBe(argsFingerprint([2, 1]));
  });

  it("treats undefined and missing args the same (fingerprint of {})", () => {
    expect(argsFingerprint(undefined)).toBe(argsFingerprint({}));
  });

  it("does not leak raw values into the fingerprint", () => {
    const fp = argsFingerprint({ token: "super-secret-value" });
    expect(fp).not.toContain("super-secret-value");
    expect(fp).toMatch(FP);
  });

  it("survives non-JSON values without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => argsFingerprint(circular)).not.toThrow();
    expect(argsFingerprint({ n: NaN, b: 10n, f: () => 1, s: Symbol("x") })).toMatch(FP);
  });
});

// ---------------------------------------------------------------------------
// Fuzz target: the fingerprint path must be TOTAL and STABLE. For any value it
// must not throw, must return a well-formed digest, and must be stable across
// repeated calls on the same input. Seeded for reproducibility in CI.
// ---------------------------------------------------------------------------
describe("argsFingerprint fuzz", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
  }
  function gen(rnd: () => number, depth: number): unknown {
    const roll = rnd();
    if (depth <= 0 || roll < 0.35) {
      const leaf = rnd();
      if (leaf < 0.15) return undefined;
      if (leaf < 0.3) return null;
      if (leaf < 0.45) return Math.floor((rnd() - 0.5) * 1e6);
      if (leaf < 0.55) return rnd() < 0.5;
      if (leaf < 0.7) return [NaN, Infinity, -Infinity][Math.floor(rnd() * 3)];
      if (leaf < 0.82) return BigInt(Math.floor(rnd() * 1e6));
      return String.fromCharCode(...Array.from({ length: Math.floor(rnd() * 8) }, () => 33 + Math.floor(rnd() * 90)));
    }
    if (roll < 0.68) {
      return Array.from({ length: Math.floor(rnd() * 5) }, () => gen(rnd, depth - 1));
    }
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < Math.floor(rnd() * 5); i++) obj[`k${Math.floor(rnd() * 8)}`] = gen(rnd, depth - 1);
    return obj;
  }

  it("never throws and is stable over 3000 seeded inputs", () => {
    const rnd = lcg(0xf00d_2026);
    for (let i = 0; i < 3000; i++) {
      const v = gen(rnd, 4);
      let fp = "";
      expect(() => { fp = argsFingerprint(v); }).not.toThrow();
      expect(fp).toMatch(FP);
      expect(argsFingerprint(v)).toBe(fp); // stable
      expect(() => canonicalize(v)).not.toThrow();
    }
  });
});
