// src/types/paperclip.ts
// Type stubs for @paperclipai/server internals.
// These match the Paperclip adapter contract — updated when Paperclip updates.

export interface PaperclipAgent {
  id: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface PaperclipRun {
  id: string;
}

export interface PaperclipCompany {
  id: string;
}

export interface PaperclipRuntime {
  sessionParams?: Record<string, unknown>;
}

export interface AdapterExecutionContext {
  agent: PaperclipAgent;
  run: PaperclipRun;
  company: PaperclipCompany;
  runtime: PaperclipRuntime;
}

export interface AdapterExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  sessionParams?: Record<string, unknown>;
  summary?: string;
}

export interface AdapterTestResult {
  level: "info" | "warn" | "error";
  message: string;
}

// Helper function stubs — these would come from @paperclipai/server in a real install
export function asString(value: unknown, defaultValue: string): string {
  return typeof value === "string" ? value : defaultValue;
}

export function asNumber(value: unknown, defaultValue: number): number {
  const n = Number(value);
  return isNaN(n) ? defaultValue : n;
}

export function asObject(value: unknown, defaultValue: Record<string, unknown>): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : defaultValue;
}

export function asArray(value: unknown, defaultValue: unknown[]): unknown[] {
  return Array.isArray(value) ? value : defaultValue;
}
