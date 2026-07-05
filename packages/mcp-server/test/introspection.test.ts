// Glama introspection contract: the MCP server must start and answer
// introspection (initialize + tools/list) with NO credentials, and only
// require credentials when an authed tool is actually called.
//
// We spawn the real server over stdio (via tsx against src, so the test
// tracks current source and needs no prior build) with an EMPTY environment
// and an empty HOME/USERPROFILE — the latter prevents a real ~/.agentvalet
// identity on the dev machine from leaking in and turning state C into state A.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const srcEntry = join(packageDir, "src", "index.ts");

// A throwaway empty home so disk-identity discovery (readBoundIdentity /
// readBoundPrivateKey) finds nothing — guarantees the no-credentials state.
const emptyHome = mkdtempSync(join(tmpdir(), "av-mcp-introspect-"));

// Empty strings are treated as "not set" by the server's envOrNull / readEnv,
// so this is the credential-less sandbox the Glama Dockerfile reproduces.
const NO_CRED_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: emptyHome,
  USERPROFILE: emptyHome,
  AGENT_ID: "",
  OWNER_ID: "",
  PROXY_URL: "",
  AGENT_PRIVATE_KEY: "",
  AGENT_PRIVATE_KEY_B64: "",
  AGENT_PRIVATE_KEY_PATH: "",
  INVITE_BIND_SECRET: "",
};

const EXPECTED_TOOLS = [
  "list_platforms",
  "use_platform",
  "agent_register",
  "agent_status",
  "authzen_evaluate",
  "report_self_diagnostic",
  "list_my_pending_actions",
  "request_platform_access",
];

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    // `--import tsx` registers the tsx ESM loader so we can run the .ts source
    // directly; tsx is a devDependency resolved from the package's node_modules.
    args: ["--import", "tsx", srcEntry],
    cwd: packageDir,
    env: NO_CRED_ENV,
  });
  client = new Client({ name: "introspection-test", version: "0.0.0" }, { capabilities: {} });
  // connect() drives the initialize handshake — if startup exits or the
  // handshake fails with no credentials, this rejects and the test fails.
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe("credential-less introspection", () => {
  it("initialize succeeds and delivers server instructions without credentials", () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toContain("use_platform");
  });

  it("tools/list returns the full static catalogue without credentials", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    // Every tool exposes a description + inputSchema for sandbox introspection.
    for (const t of tools) {
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.inputSchema, `${t.name} inputSchema`).toBeDefined();
    }
  });

  it("an authed tools/call returns a clean credentials-required result (no crash)", async () => {
    const res = await client.callTool({ name: "list_platforms", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("");
    expect(text).toContain("AgentValet credentials are not configured");
    expect(text).toContain("npx @agentvalet/register");
  });

  it("the server stays up after a credentials-required call (process did not exit)", async () => {
    // A second round-trip proves the process survived the failed authed call.
    const { tools } = await client.listTools();
    expect(tools.length).toBe(EXPECTED_TOOLS.length);
  });
});
