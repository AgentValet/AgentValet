import { readFile, writeFile, access } from "fs/promises";

const ENV_VAR_NAME = (agentId: string) =>
  `AGENTVALET_PRIVATE_KEY_${agentId.replace(/-/g, "_").toUpperCase()}`;

export async function writeKeyToEnvLocal(agentId: string, privateKeyPem: string): Promise<void> {
  const varName = ENV_VAR_NAME(agentId);
  const b64Key = Buffer.from(privateKeyPem).toString("base64");
  const line = `\n# AgentValet private key for ${agentId} (base64-encoded PEM)\n${varName}=${b64Key}\n`;

  let existing = "";
  try {
    await access(".env.local");
    existing = await readFile(".env.local", "utf-8");
  } catch {
    // File doesn't exist — start fresh
  }

  if (existing.includes(varName)) {
    const lines = existing.split("\n");
    const filtered = lines.filter((l) => !l.startsWith(`${varName}=`));
    await writeFile(".env.local", filtered.join("\n") + line, "utf-8");
  } else {
    await writeFile(".env.local", existing + line, "utf-8");
  }
}
