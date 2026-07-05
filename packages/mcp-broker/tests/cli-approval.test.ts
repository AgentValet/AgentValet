import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { CliApprovalProvider } from "../src/approval/cli-provider.js";
import type { AccessRequest, Decision } from "../src/types.js";

const req: AccessRequest = {
  subject: { id: "a", sessionId: "s" },
  action: { name: "delete_repo" },
  resource: { server: "github-tools", tool: "delete_repo" },
  context: { argsFingerprint: "sha256:0", transport: "stdio", ts: "2026-07-04T00:00:00.000Z" },
};
const decision: Decision = { effect: "require_approval", policyId: "local", version: "1" };

function provider(timeoutMs: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, prov: new CliApprovalProvider({ timeoutMs, input, output }) };
}

describe("CLI approval provider", () => {
  it("approves on 'y'", async () => {
    const { input, prov } = provider(1000);
    const p = prov.request(req, decision);
    input.write("y\n");
    expect(await p).toEqual({ approved: true });
  });

  it("declines on anything else", async () => {
    const { input, prov } = provider(1000);
    const p = prov.request(req, decision);
    input.write("n\n");
    expect(await p).toEqual({ approved: false, reason: "declined" });
  });

  it("denies with reason timeout when no answer arrives", async () => {
    const { prov } = provider(20);
    expect(await prov.request(req, decision)).toEqual({ approved: false, reason: "timeout" });
  });
});
