// Phase C5 — `agentvalet-register claim <bind_secret> [--label <name>]`.
//
// Consumes a one-shot bind_secret issued by the AgentValet claim page,
// generates an RSA-2048 keypair locally, POSTs the public key to
// /v1/invites/bind, and persists the resulting identity + key to
// ~/.agentvalet/ (or ~/.agentvalet/<label>/ when --label is provided).
//
// The label mode supports multi-agent machines — e.g. an analyst who
// already has a personal AgentValet agent installed in Claude Desktop
// can claim a work invite without overwriting their existing agent.

import { Command } from "commander";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

interface BindEndpointResponse {
  agent_id: string;
  owner_id: string;
  proxy_url: string;
  status: string;
}

interface PersistedIdentity {
  agent_id: string;
  owner_id: string;
  proxy_url: string;
  label: string | null;
  bound_at: string;
}

const DEFAULT_PROXY_URL = "https://api.agentvalet.ai";

function resolveAgentDir(label: string | null): string {
  const root = join(homedir(), ".agentvalet");
  return label ? join(root, label) : root;
}

function sanitiseLabel(label: string): string {
  // Filesystem + MCP-server-name safe: lowercase, dashes, alphanumerics.
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function postBind(
  proxyUrl: string,
  bindSecret: string,
  publicKeyPem: string,
): Promise<BindEndpointResponse> {
  const url = `${proxyUrl.replace(/\/$/, "")}/v1/invites/bind`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bind_secret: bindSecret, public_key_pem: publicKeyPem }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore
    }
    if (res.status === 410) {
      throw new Error(
        `Bind secret rejected (${detail}). It was either already used or expired — ask the inviting manager to re-issue.`,
      );
    }
    throw new Error(`Invite bind failed: ${detail}`);
  }
  return (await res.json()) as BindEndpointResponse;
}

export function claimCommand(): Command {
  return new Command("claim")
    .description("Bind an AgentValet agent from a one-shot invite secret")
    .argument("<bind_secret>", "The bsec_… value shown on the AgentValet claim page")
    .option("--label <name>", "Save under ~/.agentvalet/<label>/ for multi-agent machines")
    .option("--api-url <url>", "AgentValet proxy URL", DEFAULT_PROXY_URL)
    .option("--json", "Machine-readable JSON output")
    .action(async (bindSecret: string, opts: { label?: string; apiUrl: string; json?: boolean }) => {
      const isJson = !!opts.json;
      const rawLabel = opts.label?.trim() ?? "";
      const label = rawLabel ? sanitiseLabel(rawLabel) : null;
      if (rawLabel && label !== rawLabel.toLowerCase()) {
        if (!isJson) {
          console.error(chalk.yellow(`Note: label sanitised to "${label}"`));
        }
      }

      if (!bindSecret.startsWith("bsec_")) {
        const msg = "bind_secret should start with 'bsec_'";
        console.error(isJson ? JSON.stringify({ error: msg }) : chalk.red(msg));
        process.exit(3);
      }

      const agentDir = resolveAgentDir(label);
      const keyPath = join(agentDir, "agent.key");
      const identityPath = join(agentDir, "agent.json");

      if (existsSync(keyPath)) {
        const msg = label
          ? `An agent already exists at ${keyPath}. Pick a different --label or remove the directory first.`
          : `A default agent already exists at ${keyPath}. Pass --label <name> to claim alongside it without overwriting.`;
        console.error(isJson ? JSON.stringify({ error: msg }) : chalk.red(msg));
        process.exit(3);
      }

      const proxyUrl = opts.apiUrl.replace(/\/$/, "");

      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      let payload: BindEndpointResponse;
      try {
        payload = await postBind(proxyUrl, bindSecret, publicKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(isJson ? JSON.stringify({ error: msg }) : chalk.red(msg));
        process.exit(3);
      }

      if (!payload.agent_id || !payload.owner_id || !payload.proxy_url) {
        const msg = "Bind succeeded but response was missing required fields";
        console.error(isJson ? JSON.stringify({ error: msg }) : chalk.red(msg));
        process.exit(3);
      }

      const identity: PersistedIdentity = {
        agent_id: payload.agent_id,
        owner_id: payload.owner_id,
        proxy_url: payload.proxy_url,
        label,
        bound_at: new Date().toISOString(),
      };

      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      writeFileSync(keyPath, privateKey, { mode: 0o600 });
      writeFileSync(identityPath, JSON.stringify(identity, null, 2));

      const mcpServerName = label ? `agentvalet-${label}` : "agentvalet";
      const mcpEnv = label
        ? {
            AGENT_ID: payload.agent_id,
            OWNER_ID: payload.owner_id,
            PROXY_URL: payload.proxy_url,
            AGENT_PRIVATE_KEY_PATH: keyPath,
          }
        : {
            // For the default install, mcp-server picks up agent.key from
            // ~/.agentvalet/ automatically — only PROXY_URL is needed.
            PROXY_URL: payload.proxy_url,
          };

      if (isJson) {
        console.log(JSON.stringify({
          status: "bound",
          agent_id: payload.agent_id,
          owner_id: payload.owner_id,
          proxy_url: payload.proxy_url,
          key_path: keyPath,
          identity_path: identityPath,
          label,
          mcp_server_name: mcpServerName,
        }));
        return;
      }

      console.log(chalk.green(`\n✓ Bound as ${payload.agent_id}`));
      console.log(chalk.gray(`  owner:    ${payload.owner_id}`));
      console.log(chalk.gray(`  proxy:    ${payload.proxy_url}`));
      console.log(chalk.gray(`  key:      ${keyPath}`));
      console.log(chalk.gray(`  identity: ${identityPath}`));

      console.log(chalk.cyan("\nAdd this to your Claude Desktop / Claude Code MCP config:"));
      const snippet = {
        mcpServers: {
          [mcpServerName]: {
            command: "npx",
            args: ["-y", "@agentvalet/mcp-server"],
            env: mcpEnv,
          },
        },
      };
      console.log(JSON.stringify(snippet, null, 2));

      if (label) {
        console.log(chalk.gray(`\nKeep the named entry (${mcpServerName}) so it lives alongside any existing AgentValet agents on this machine.`));
      } else {
        console.log(chalk.gray(`\nOr run 'agentvalet-register inject' to write this into ~/.claude.json automatically.`));
      }
    });
}
