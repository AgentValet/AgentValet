import { SignJWT, importPKCS8 } from "jose";

export interface AgentTokenClaims {
  sub: string;            // SPIFFE ID
  iss: string;
  aud: string;
  agentId: string;
  paperclipAgentId: string;
  runId: string;
  companyId: string;
}

export async function mintAgentToken(params: {
  privateKeyPem: string;
  agentId: string;
  paperclipAgentId: string;
  ownerId: string;
  runId: string;
  companyId: string;
  ttlSec: number;
}): Promise<string> {
  const privateKey = await importPKCS8(params.privateKeyPem, "RS256");

  const claims: AgentTokenClaims = {
    sub: `spiffe://agentvalet.ai/owner/${params.ownerId}/agent/${params.agentId}`,
    iss: "agentvalet-paperclip-adapter",
    aud: "agentvalet-proxy",
    agentId: params.agentId,
    paperclipAgentId: params.paperclipAgentId,
    runId: params.runId,
    companyId: params.companyId,
  };

  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(`${params.ttlSec}s`)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}
