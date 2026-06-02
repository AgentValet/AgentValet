export class CompanyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyKeyError';
  }
}

/**
 * Normalises an RSA private key PEM from any of the three common
 * formats used when storing multi-line values in environment variables:
 *
 *   1. Correct multi-line PEM (pass-through)
 *   2. Escaped newlines (literal \n as two characters)
 *   3. Base64-encoded PEM
 *
 * Throws CompanyKeyError with a clear, actionable message for every
 * failure case.
 */
export function normalisePem(raw: string, envVarName: string): string {
  if (!raw || raw.trim() === '') {
    throw new CompanyKeyError(
      `${envVarName} is not set.\n\n` +
      `Set it to your RS256 private key. You have three options:\n` +
      `  1. Generate a keypair in AgentValet → Settings → Integrations → Paperclip\n` +
      `     (recommended — AgentValet generates it and shows the private key once)\n` +
      `  2. Generate with openssl:\n` +
      `     openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out company.key\n` +
      `     Then paste the contents as ${envVarName}\n` +
      `  3. Generate with Node.js crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })\n\n` +
      `If the PEM contains newlines, you may need to:\n` +
      `  - Escape them: replace actual newlines with \\n\n` +
      `  - Or base64 encode the entire PEM and set as ${envVarName}_B64\n`
    );
  }

  let pem = raw.trim();

  // Case 3: already a valid multi-line PEM — detect and return early
  if (pem.startsWith('-----BEGIN')) {
    pem = pem.replace(/\\n/g, '\n');
    validatePem(pem, envVarName);
    return pem;
  }

  // Case 1: escaped newlines only (no -----BEGIN yet visible)
  if (pem.includes('\\n')) {
    pem = pem.replace(/\\n/g, '\n');
    if (pem.startsWith('-----BEGIN')) {
      validatePem(pem, envVarName);
      return pem;
    }
  }

  // Case 2: base64 encoded PEM
  try {
    const decoded = Buffer.from(pem, 'base64').toString('utf8');
    if (decoded.startsWith('-----BEGIN')) {
      const normalised = decoded.replace(/\\n/g, '\n');
      validatePem(normalised, envVarName);
      return normalised;
    }
  } catch {
    // Not valid base64 — fall through to error
  }

  throw new CompanyKeyError(
    `${envVarName} does not appear to be a valid RSA private key.\n\n` +
    `Expected one of:\n` +
    `  - A PEM starting with -----BEGIN PRIVATE KEY-----\n` +
    `  - A PEM with escaped newlines (\\n)\n` +
    `  - A base64-encoded PEM\n\n` +
    `Got: "${pem.substring(0, 40)}..."\n\n` +
    `To generate a valid key, go to:\n` +
    `AgentValet → Settings → Integrations → Paperclip → Generate keypair`
  );
}

/**
 * Reads and normalises the company PEM from environment variables.
 * Checks for ${envVarName}_B64 first — explicit base64 takes precedence.
 */
export function readPemFromEnv(envVarName: string): string {
  const b64Value = process.env[`${envVarName}_B64`];
  if (b64Value) {
    return normalisePem(b64Value, `${envVarName}_B64`);
  }

  const rawValue = process.env[envVarName] ?? '';
  return normalisePem(rawValue, envVarName);
}

function validatePem(pem: string, envVarName: string): void {
  const hasHeader = pem.includes('-----BEGIN PRIVATE KEY-----') ||
                    pem.includes('-----BEGIN RSA PRIVATE KEY-----') ||
                    pem.includes('-----BEGIN PKCS8 PRIVATE KEY-----');
  const hasFooter = pem.includes('-----END PRIVATE KEY-----') ||
                    pem.includes('-----END RSA PRIVATE KEY-----') ||
                    pem.includes('-----END PKCS8 PRIVATE KEY-----');

  if (!hasHeader || !hasFooter) {
    throw new CompanyKeyError(
      `${envVarName} appears to be a PEM but is missing the header or footer.\n` +
      `Ensure the full key is set including:\n` +
      `  -----BEGIN PRIVATE KEY-----\n` +
      `  ... (key body) ...\n` +
      `  -----END PRIVATE KEY-----`
    );
  }
}
