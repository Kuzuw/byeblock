#!/usr/bin/env node
// Builds dist/byeblock-<version>.zip, ready for the Chrome Web Store,
// addons.mozilla.org, or "Load unpacked" after extracting.
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `byeblock-${version}.zip`);

mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });
execFileSync(
  'zip',
  ['-r', '-X', '-q', out, 'manifest.json', 'LICENSE.md', 'src', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png'],
  { cwd: root, stdio: 'inherit' },
);
console.log(`Wrote ${out}`);
