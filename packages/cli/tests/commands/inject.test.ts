import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
}));
vi.mock("fs/promises", () => mockFs);

import { writeKeyToEnvLocal } from "../../src/lib/env-writer.js";
import { writeKeyToClaudeConfig } from "../../src/lib/claude-config.js";

beforeEach(() => { vi.clearAllMocks(); });

describe("writeKeyToEnvLocal", () => {
  it("creates .env.local with the key when file does not exist", async () => {
    mockFs.access.mockRejectedValueOnce({ code: "ENOENT" });
    mockFs.writeFile.mockResolvedValueOnce(undefined);

    await writeKeyToEnvLocal("agt_abc123", "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----");

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      ".env.local",
      expect.stringContaining("AGENTVALET_PRIVATE_KEY_AGT_ABC123"),
      "utf-8"
    );
  });

  it("appends to existing .env.local without overwriting other vars", async () => {
    mockFs.access.mockResolvedValueOnce(undefined);
    mockFs.readFile.mockResolvedValueOnce("EXISTING_VAR=foo\n");
    mockFs.writeFile.mockResolvedValueOnce(undefined);

    await writeKeyToEnvLocal("agt_abc123", "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----");

    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain("EXISTING_VAR=foo");
    expect(written).toContain("AGENTVALET_PRIVATE_KEY_AGT_ABC123");
  });
});

describe("writeKeyToClaudeConfig", () => {
  it("writes key to ~/.claude/config under agent_keys section", async () => {
    mockFs.access.mockRejectedValueOnce({ code: "ENOENT" });
    mockFs.mkdir.mockResolvedValueOnce(undefined);
    mockFs.writeFile.mockResolvedValueOnce(undefined);

    await writeKeyToClaudeConfig("agt_abc123", "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----");

    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain("agt_abc123");
    // base64-encoded PEM won't contain "BEGIN PRIVATE KEY" literally
    expect(JSON.parse(written).agent_keys["agt_abc123"]).toBeTruthy();
  });
});
