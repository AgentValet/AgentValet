#!/usr/bin/env node
const { existsSync, copyFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const root = process.env.INIT_CWD ?? process.cwd();
const src = __dirname;

const droidsDir = join(root, '.factory', 'droids');
const commandsDir = join(root, '.factory', 'commands');

if (!existsSync(droidsDir)) mkdirSync(droidsDir, { recursive: true });
if (!existsSync(commandsDir)) mkdirSync(commandsDir, { recursive: true });

const files = [
  { src: 'agentvalet.yaml', dest: join(droidsDir, 'agentvalet.yaml') },
  { src: 'av-status.md', dest: join(commandsDir, 'av-status.md') },
  { src: 'av-register.md', dest: join(commandsDir, 'av-register.md') },
];

for (const file of files) {
  if (existsSync(file.dest)) {
    console.log(`[agentvalet] ${file.dest} already exists — skipping`);
    continue;
  }
  copyFileSync(join(src, file.src), file.dest);
  console.log(`[agentvalet] Created ${file.dest}`);
}

console.log('[agentvalet] Factory Droid droid installed.');
console.log('[agentvalet] Run: npx @agentvalet/register');
