#!/usr/bin/env node
// Copies AGENTS.md (and optionally CLAUDE.md, SKILL.md) to the project root.
// Run automatically on npm install, or manually: node install.js

const { existsSync, copyFileSync } = require('fs');
const { join } = require('path');

const projectRoot = process.env.INIT_CWD ?? process.cwd();
const packageDir = __dirname;

const files = [
  { src: 'AGENTS.md', dest: 'AGENTS.md', required: true },
  { src: 'CLAUDE.md', dest: 'CLAUDE.md', required: false },
  { src: 'SKILL.md',  dest: 'SKILL.md',  required: false },
];

for (const file of files) {
  const destPath = join(projectRoot, file.dest);
  const srcPath  = join(packageDir, file.src);

  if (existsSync(destPath)) {
    console.log(`[agentvalet] ${file.dest} already exists — skipping`);
    continue;
  }

  copyFileSync(srcPath, destPath);
  console.log(`[agentvalet] Created ${file.dest} in project root`);
}

console.log('[agentvalet] Done. Review the files and commit them to your repo.');
