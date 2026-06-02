import { mintAgentToken } from "./jwt.js";
import { generateAgentValetSkill } from "./skill.js";
import { readPemFromEnv, CompanyKeyError } from "./pem.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types/paperclip.js";
import { asString, asNumber, asObject, asArray } from "../types/paperclip.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ── Company env vars ──────────────────────────────────────────────────────────

function readCompanyEnv(): { proxyUrl: string; ownerId: string; companyKeyPem: string } {
  const proxyUrl = (process.env.AGENTVALET_PROXY_URL ?? "").replace(/\/$/, "");
  const ownerId = process.env.AGENTVALET_OWNER_ID ?? "";
  if (!proxyUrl) throw new Error(
    "AGENTVALET_PROXY_URL is not set. Add it to your Paperclip instance environment."
  );
  if (!ownerId) throw new Error(
    "AGENTVALET_OWNER_ID is not set. Find your Owner ID in AgentValet Settings."
  );
  const companyKeyPem = readPemFromEnv('AGENTVALET_COMPANY_KEY');

  return { proxyUrl, ownerId, companyKeyPem };
}

// ── Auto-registration ─────────────────────────────────────────────────────────

interface RegistrationResult {
  agentvaletAgentId: string;
}

async function autoRegister(params: {
  proxyUrl: string;
  ownerId: string;
  companyKeyPem: string;
  paperclipAgentId: string;
  paperclipAgentName: string;
  paperclipCompanyId: string;
  requestedScopes: string[];
  registrationTimeoutSec: number;
}): Promise<RegistrationResult | null> {
  const regResp = await fetch(`${params.proxyUrl}/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: params.paperclipAgentName,
      paperclip_agent_id: params.paperclipAgentId,
      paperclip_company_id: params.paperclipCompanyId,
      owner_id: params.ownerId,
      requested_scopes: params.requestedScopes,
    }),
  });

  if (!regResp.ok) {
    throw new Error(`AgentValet registration failed: ${regResp.status} ${regResp.statusText}`);
  }

  const { token } = await regResp.json() as { token: string };

  const deadline = Date.now() + params.registrationTimeoutSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));

    const statusResp = await fetch(`${params.proxyUrl}/v1/register/status/${token}`);
    if (!statusResp.ok) continue;

    const { status, agent_id } = await statusResp.json() as { status: string; agent_id?: string };

    if (status === "approved" && agent_id) {
      return { agentvaletAgentId: agent_id };
    }
    if (status === "rejected") {
      throw new Error(
        "AgentValet registration was rejected by the owner. Check the AgentValet dashboard."
      );
    }
  }

  return null; // still pending — not an error
}

// ── Main execute ──────────────────────────────────────────────────────────────

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { agent, run, company } = ctx;
  const config = agent.adapterConfig ?? {};

  const underlyingAdapter = asString(config.underlyingAdapter, "claude_local");
  const underlyingAdapterConfig = asObject(config.underlyingAdapterConfig, {});
  const requestedScopes = asArray(config.agentvaletScopes, []) as string[];
  const approvalTimeoutSec = asNumber(config.approvalTimeoutSec, 60);
  const tokenTtlSec = asNumber(config.tokenTtlSec, 300);
  const registrationTimeoutSec = asNumber(config.registrationTimeoutSec, 120);

  let envVars: { proxyUrl: string; ownerId: string; companyKeyPem: string };
  try {
    envVars = readCompanyEnv();
  } catch (err) {
    if (err instanceof CompanyKeyError) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        durationMs: 0,
        summary:
          `AgentValet company key error: ${err.message.split('\n')[0]}\n` +
          `Check your Paperclip instance environment variables.`,
      };
    }
    throw err;
  }
  const { proxyUrl, ownerId, companyKeyPem } = envVars;

  // Resolve AgentValet agent_id from session state or auto-register
  let avAgentId: string = (ctx.runtime.sessionParams?.agentvaletAgentId as string | undefined) ?? "";

  if (!avAgentId) {
    console.log(`[agentvalet] No AgentValet ID cached for "${agent.name}". Auto-registering...`);

    const regResult = await autoRegister({
      proxyUrl,
      ownerId,
      companyKeyPem,
      paperclipAgentId: agent.id,
      paperclipAgentName: agent.name,
      paperclipCompanyId: company.id,
      requestedScopes,
      registrationTimeoutSec,
    });

    if (!regResult) {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
        sessionParams: { ...ctx.runtime.sessionParams },
        summary:
          `⏳ Waiting for AgentValet approval. ` +
          `Open your AgentValet dashboard to approve "${agent.name}". ` +
          `This agent will resume automatically once approved.`,
      };
    }

    avAgentId = regResult.agentvaletAgentId;
    console.log(`[agentvalet] Registered: ${avAgentId}`);
  }

  // Mint JWT for this run
  const agentToken = await mintAgentToken({
    privateKeyPem: companyKeyPem,
    agentId: avAgentId,
    paperclipAgentId: agent.id,
    ownerId,
    runId: run.id,
    companyId: company.id,
    ttlSec: tokenTtlSec,
  });

  // Generate SKILL.md in tmpdir
  const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentvalet-skills-"));
  const skillContent = generateAgentValetSkill({ proxyUrl, agentId: avAgentId });
  await fs.writeFile(path.join(skillsDir, "AGENTVALET.md"), skillContent, "utf8");

  // Build env for underlying adapter
  const agentvaletEnv: Record<string, string> = {
    AGENTVALET_PROXY_URL: proxyUrl,
    AGENTVALET_AGENT_TOKEN: agentToken,
    AGENTVALET_AGENT_ID: avAgentId,
    AGENTVALET_APPROVAL_TIMEOUT_SEC: String(approvalTimeoutSec),
  };

  // Delegate to underlying adapter via dynamic import (available in live Paperclip instance)
  const mergedUnderlyingConfig = {
    ...underlyingAdapterConfig,
    env: {
      ...((underlyingAdapterConfig.env as Record<string, string> | undefined) ?? {}),
      ...agentvaletEnv,
    },
    _agentvaletSkillsDir: skillsDir,
  };

  const underlyingCtx: AdapterExecutionContext = {
    ...ctx,
    agent: {
      ...agent,
      adapterType: underlyingAdapter,
      adapterConfig: mergedUnderlyingConfig,
    },
  };

  let result!: AdapterExecutionResult;
  try {
    // Dynamic import: available when running inside a live Paperclip instance
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — module available at runtime in Paperclip instance
    const registry = await import("@paperclipai/server/adapters/registry.js") as {
      getAdapter: (type: string) => { execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult> } | undefined;
    };
    const underlying = registry.getAdapter(underlyingAdapter);
    if (!underlying) {
      throw new Error(`Underlying adapter "${underlyingAdapter}" not found in registry`);
    }
    result = await underlying.execute(underlyingCtx);
  } finally {
    await fs.rm(skillsDir, { recursive: true, force: true });
  }

  // Fire-and-forget audit POST — never let it block
  fetch(`${proxyUrl}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${agentToken}`,
    },
    body: JSON.stringify({
      paperclip_run_id: run.id,
      paperclip_agent_id: agent.id,
      paperclip_company_id: company.id,
      agent_id: avAgentId,
      outcome: result.exitCode === 0 ? "success" : "error",
      duration_ms: result.durationMs,
    }),
  }).catch((err: Error) => {
    console.warn("[agentvalet] Failed to post run audit:", err.message);
  });

  return {
    ...result,
    sessionParams: {
      ...result.sessionParams,
      agentvaletAgentId: avAgentId,
    },
  };
}
