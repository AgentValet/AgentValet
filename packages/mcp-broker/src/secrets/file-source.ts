// The file: secret source. Reads a JSON map of credential ref -> secret from
// disk. The file may be plaintext JSON, or AES-256-GCM encrypted at rest when
// AGENTVALET_SECRETS_KEY is set (a 32-byte key, hex or base64). Encryption uses
// only node:crypto, so the package keeps zero runtime dependencies.
//
// Encrypted file layout (utf-8 text): "v1:<base64 iv>:<base64 tag>:<base64 ct>".
// Plaintext file layout: a JSON object, each value either a bare token string or
// { token, scope?, expiresAt? }.
//
// Like env:, this source stamps the requested narrowed scope onto the returned
// credential. It can carry an expiry if the file declares one; where it does
// not, the pipeline warns just as it does for env:.
import { readFile } from "node:fs/promises";
import { createDecipheriv } from "node:crypto";
import { narrowedScope } from "./narrow.js";
import type { Credential, CredentialRef, Decision, SecretSource } from "../types.js";

type StoredValue = string | { token: string; scope?: string[]; expiresAt?: string };
type SecretMap = Record<string, StoredValue>;

function decodeKey(raw: string): Buffer {
  const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (hex.length !== 32) throw new Error("AGENTVALET_SECRETS_KEY must decode to 32 bytes (hex or base64)");
  return hex;
}

export function decryptSecretsFile(contents: string, key: Buffer): string {
  const parts = contents.trim().split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error('encrypted secrets file must be "v1:<iv>:<tag>:<ciphertext>"');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return decipher.update(Buffer.from(ctB64, "base64")).toString("utf8") + decipher.final("utf8");
}

export class FileSecretSource implements SecretSource {
  private map: SecretMap | null = null;

  constructor(
    private readonly path: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private async load(): Promise<SecretMap> {
    if (this.map) return this.map;
    const raw = await readFile(this.path, "utf8");
    const keyRaw = this.env.AGENTVALET_SECRETS_KEY;
    const json = keyRaw ? decryptSecretsFile(raw, decodeKey(keyRaw)) : raw;
    const parsed = JSON.parse(json) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("secrets file must be a JSON object of ref -> token");
    }
    this.map = parsed as SecretMap;
    return this.map;
  }

  async resolve(ref: CredentialRef, decision: Decision): Promise<Credential> {
    const map = await this.load();
    const stored = map[ref.id];
    if (stored === undefined) throw new Error(`secret not found in file: "${ref.id}"`);
    const scope = narrowedScope(ref, decision);

    if (typeof stored === "string") {
      return scope ? { token: stored, scope } : { token: stored };
    }
    if (!stored || typeof stored.token !== "string") {
      throw new Error(`malformed secret entry for "${ref.id}"`);
    }
    const cred: Credential = { token: stored.token };
    // A narrowed scope from the decision wins over the file's declared scope.
    const finalScope = scope ?? stored.scope;
    if (finalScope) cred.scope = finalScope;
    if (stored.expiresAt) cred.expiresAt = new Date(stored.expiresAt);
    return cred;
  }
}
