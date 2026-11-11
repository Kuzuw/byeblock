#!/usr/bin/env node
// Sanity checks for the extension: manifest is valid JSON, every file it
// references exists, versions agree, and every script parses.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const read = (p) => readFileSync(join(root, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

const referenced = new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...(manifest.background?.scripts || []),
  ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
]);
for (const file of referenced) {
  if (file && !existsSync(join(root, file))) errors.push(`manifest references missing file: ${file}`);
}

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');

const versions = {
  'manifest.json': manifest.version,
  'package.json': JSON.parse(read('package.json')).version,
  'server/package.json': JSON.parse(read('server/package.json')).version,
};
if (new Set(Object.values(versions)).size !== 1) errors.push(`version mismatch: ${JSON.stringify(versions)}`);

const scripts = [
  ...readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
  'server/server.mjs',
];
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  } catch (err) {
    errors.push(`${file}: ${String(err.stderr).trim()}`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✓ manifest v${manifest.version} OK, ${referenced.size} referenced files, ${scripts.length} scripts parse`);
