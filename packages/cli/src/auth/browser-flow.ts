import { createServer } from "http";
import { createRequire } from "module";
import open from "open";
import chalk from "chalk";

const _require = createRequire(import.meta.url);

// cli-auth is called through the AgentValet proxy (gateway key injected
// server-side). Override with AGENTVALET_API_URL when self-hosting.
const API_URL = process.env.AGENTVALET_API_URL ?? "https://api.agentvalet.ai";
const FUNCTIONS_URL = `${API_URL}/functions/v1`;
const APP_URL = "https://app.agentvalet.ai";
const CALLBACK_TIMEOUT_MS = 120_000;

export interface BrowserLoginResult {
  ownerId: string;
  orgId: string | null;
  cliToken: string;
  email: string | null;
  proxyUrl: string;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { reject(new Error("Could not bind port")); return; }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function callCliAuth(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${FUNCTIONS_URL}/cli-auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = text ? JSON.parse(text) as Record<string, unknown> : null; } catch { /* keep raw */ }
  if (!res.ok) {
    const err = (json?.error as string | undefined) ?? text ?? `HTTP ${res.status}`;
    const detail = (json?.detail as string | undefined) ?? "";
    throw new Error(detail ? `${err}: ${detail}` : err);
  }
  return json ?? {};
}

/**
 * Opens the user's browser to the AgentValet dashboard, where they click "Authorize",
 * which redirects back to a local HTTP server on the CLI side. Returns owner credentials
 * without any copy-pasting.
 */
export async function browserLogin(): Promise<BrowserLoginResult> {
  const state = crypto.randomUUID();
  const port = await findFreePort();

  // Register the state server-side so the dashboard can look it up
  await callCliAuth({ action: "init", state, port });

  // Start the local callback server
  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<!doctype html><html><head><title>AgentValet CLI</title>" +
        "<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;" +
        "min-height:100vh;margin:0;background:#060e1a;color:rgba(255,255,255,.87)}" +
        "h2{margin:0 0 8px}p{margin:0;color:rgba(255,255,255,.45);font-size:14px}</style></head>" +
        "<body><div style='text-align:center'>" +
        "<h2 style='color:#34c97b'>&#10003; Authorized</h2>" +
        "<p>You can close this tab and return to your terminal.</p>" +
        "</div></body></html>",
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error("No code in callback URL"));
    });

    server.listen(port, "127.0.0.1");

    server.on("error", (err) => reject(err));

    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for browser authorization (2 min)"));
    }, CALLBACK_TIMEOUT_MS);
  });

  // Open browser
  const authUrl = `${APP_URL}/cli-auth?state=${state}&port=${port}`;
  console.log(chalk.dim(`\n  Opening browser to authorize...`));
  console.log(chalk.dim(`  URL: ${authUrl}\n`));
  await open(authUrl).catch(() => {
    console.log(chalk.yellow(`  Could not open browser automatically.`));
    console.log(chalk.yellow(`  Please open this URL in your browser:\n`));
    console.log(`  ${authUrl}\n`);
  });

  // Wait for callback
  const code = await codePromise;

  // Exchange code for credentials
  const result = await callCliAuth({ action: "exchange", state, code });

  return {
    ownerId: result.owner_id as string,
    orgId: (result.org_id as string | null) ?? null,
    cliToken: result.cli_token as string,
    email: (result.email as string | null) ?? null,
    proxyUrl: (result.proxy_url as string | undefined) ?? "https://api.agentvalet.ai",
  };
}
