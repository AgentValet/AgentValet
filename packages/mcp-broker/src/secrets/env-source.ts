// The env: secret source. Resolves a credential reference to a token held in an
// environment variable. It is a pass-through: it cannot mint a genuinely
// narrowed token, so it stamps the requested scope onto the returned credential
// as metadata and returns no expiry. The pipeline turns that missing expiry into
// a loud audit warning, because a static long-lived secret is exactly what the
// hosted plane exists to replace.
//
// Ref-to-variable mapping: the ref id is upper-cased with non-alphanumerics
// folded to underscores, then prefixed. `env:` uses no prefix; `env:GH_` looks
// up GH_<REF>.
import { narrowedScope } from "./narrow.js";
import type { Credential, CredentialRef, Decision, SecretSource } from "../types.js";

export function envVarName(ref: string, prefix: string): string {
  const norm = ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${prefix}${norm}`;
}

export class EnvSecretSource implements SecretSource {
  constructor(
    private readonly prefix = "",
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async resolve(ref: CredentialRef, decision: Decision): Promise<Credential> {
    const name = envVarName(ref.id, this.prefix);
    const token = this.env[name];
    if (token === undefined || token === "") {
      // No secret means we cannot satisfy the call. Throw so the pipeline denies
      // rather than invoking the handler with an empty token.
      throw new Error(`env secret not found: ${name} (for credential "${ref.id}")`);
    }
    const scope = narrowedScope(ref, decision);
    return scope ? { token, scope } : { token };
  }
}
