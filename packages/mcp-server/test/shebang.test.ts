import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoPkgRoot = join(here, "..");

// Regression test for the Glama build failure (1.1.0): the package's `bin`
// (dist/index.js) had no shebang, so `npm install -g` linked a binary the
// kernel could not exec — the shell ran the JS as /bin/sh and crashed with
// "//: Permission denied" / 'Syntax error: "(" unexpected'. The fix is a
// leading `#!/usr/bin/env node`; tsc preserves a source shebang into emit.
describe("bin shebang", () => {
  it("src/index.ts (the bin source) starts with the node shebang", () => {
    const src = readFileSync(join(repoPkgRoot, "src", "index.ts"), "utf8");
    // Tolerate CRLF in the working tree; the emitted bin is normalized to LF.
    expect(/^#!\/usr\/bin\/env node\r?\n/.test(src)).toBe(true);
  });

  it("built dist/index.js ships a clean LF shebang (no CRLF that breaks Linux exec)", () => {
    const distPath = join(repoPkgRoot, "dist", "index.js");
    if (!existsSync(distPath)) return; // dist only present after `npm run build`
    const dist = readFileSync(distPath, "utf8");
    // Must be exactly the LF-terminated shebang. A trailing \r makes Linux look
    // for the interpreter "node\r" → "env: 'node\r': No such file or directory".
    expect(dist.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(dist.startsWith("#!/usr/bin/env node\r")).toBe(false);
  });
});
