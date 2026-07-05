// The jsonl: audit sink. Appends one JSON object per line to a file. Append-only
// by construction (fs append), newline-delimited so it streams and greps
// cleanly, and it only ever writes the AuditEvent it is handed, which already
// carries an args fingerprint and never raw arguments.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent, AuditSink } from "../types.js";

export class JsonlAuditSink implements AuditSink {
  private ensured = false;

  constructor(private readonly path: string) {}

  async emit(event: AuditEvent): Promise<void> {
    if (!this.ensured) {
      await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
      this.ensured = true;
    }
    await appendFile(this.path, JSON.stringify(event) + "\n", "utf8");
  }
}

// An in-memory sink, handy for tests and for embedding without a file. Not a
// string scheme; constructed directly.
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
