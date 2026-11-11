#!/usr/bin/env node
// Builds dist/byeblock-<version>-chrome.zip and dist/byeblock-<version>-firefox.zip.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { firefoxManifest } from './firefox-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const FILES = ['LICENSE.md', 'src', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png'];

mkdirSync(join(root, 'dist'), { recursive: true });

for (const [target, json] of [
  ['chrome', manifest],
  ['firefox', firefoxManifest(manifest)],
]) {
  const stage = mkdtempSync(join(tmpdir(), `byeblock-${target}-`));
  for (const f of FILES) cpSync(join(root, f), join(stage, f), { recursive: true });
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(json, null, 2) + '\n');
  const out = join(root, 'dist', `byeblock-${manifest.version}-${target}.zip`);
  rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', out, 'manifest.json', ...FILES], { cwd: stage, stdio: 'inherit' });
  rmSync(stage, { recursive: true, force: true });
  console.log(`Wrote ${out}`);
}
