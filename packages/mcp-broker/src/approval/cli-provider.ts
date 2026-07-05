// The reference ApprovalProvider: a command-line y/n prompt with a timeout.
// It is the local stand-in for the hosted push-approval flow. When it times out
// or the operator declines, it returns approved: false and the pipeline denies
// the call and audits the outcome. Deny-on-timeout is the safe default.
//
// Streams and the timer are injectable so the behaviour is testable without a
// real TTY.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  AccessRequest,
  ApprovalProvider,
  ApprovalResult,
  Decision,
} from "../types.js";

export interface CliApprovalOptions {
  timeoutMs?: number;
  input?: Readable;
  output?: Writable;
}

export class CliApprovalProvider implements ApprovalProvider {
  private readonly timeoutMs: number;
  private readonly input: Readable;
  private readonly output: Writable;

  constructor(opts: CliApprovalOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stderr;
  }

  request(req: AccessRequest, decision: Decision): Promise<ApprovalResult> {
    const rl = createInterface({ input: this.input, output: this.output });
    const prompt =
      `\nApproval required: ${req.resource.server}/${req.resource.tool}\n` +
      `  subject:  ${req.subject.id} (session ${req.subject.sessionId})\n` +
      `  args:     ${req.context.argsFingerprint}\n` +
      `  policy:   ${decision.policyId} v${decision.version}\n` +
      `Approve this call? [y/N] `;

    return new Promise<ApprovalResult>((resolve) => {
      let settled = false;
      const finish = (result: ApprovalResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl.close();
        resolve(result);
      };

      const timer = setTimeout(() => finish({ approved: false, reason: "timeout" }), this.timeoutMs);
      // Do not let the timer hold the event loop open on its own.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }

      rl.question(prompt, (answer) => {
        const yes = /^\s*y(es)?\s*$/i.test(answer);
        finish(yes ? { approved: true } : { approved: false, reason: "declined" });
      });
    });
  }
}
