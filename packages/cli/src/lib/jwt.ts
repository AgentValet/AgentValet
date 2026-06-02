import { createSign, createPrivateKey } from "crypto";

export function signJwt(
  agentId: string,
  ownerId: string,
  privateKeyPem: string
): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({ agent_id: agentId, owner_id: ownerId, iat: now, exp: now + 300 })
  );
  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  return `${signingInput}.${sign.sign(createPrivateKey(privateKeyPem), "base64url")}`;
}
