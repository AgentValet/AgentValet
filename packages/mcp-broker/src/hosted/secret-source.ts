// The agentvalet: secret source. Asks the hosted control plane to resolve a
// short-lived, scope-narrowed credential for this one call, honouring the
// decision's obligations. The narrowing happens server-side against the
// envelope-encrypted vault; the broker only forwards the reference and the
// obligations and receives back a minted credential.
//
// This is the source that carries the sharpest open/paid distinction: the
// hosted plane mints a short-lived scoped token, whereas the local env:/file:
// sources can only pass a static secret through. See the seam note for the
// server contract and the credentials-never-in-responses constraint it works
// within.
import { HostedClient, type HostedOptions } from "./client.js";
import { BROKER_CREDENTIAL } from "./endpoints.js";
import type { Credential, CredentialRef, Decision, SecretSource } from "../types.js";

interface MintedCredential {
  token: string;
  scope?: string[];
  expiresAt?: string;
}

export class AgentvaletSecretSource implements SecretSource {
  private readonly client: HostedClient;

  constructor(opts: HostedOptions) {
    this.client = new HostedClient(opts);
  }

  async resolve(ref: CredentialRef, decision: Decision): Promise<Credential> {
    const minted = (await this.client.request("POST", BROKER_CREDENTIAL, {
      ref: ref.id,
      // Forward the obligations verbatim so the server does the narrowing; the
      // broker never decides scope itself in hosted mode.
      obligations: decision.obligations ?? [],
      requestedScope: ref.scope,
    })) as MintedCredential;

    if (!minted || typeof minted.token !== "string") {
      throw new Error(`hosted credential mint returned no token for "${ref.id}"`);
    }
    const cred: Credential = { token: minted.token };
    if (minted.scope) cred.scope = minted.scope;
    if (minted.expiresAt) cred.expiresAt = new Date(minted.expiresAt);
    return cred;
  }
}
