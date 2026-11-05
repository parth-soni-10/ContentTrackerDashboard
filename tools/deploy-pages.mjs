#!/usr/bin/env node
/**
 * Stage the repository for a Cloudflare Pages build.
 *
 *   node tools/deploy-pages.mjs --assets . --out .pages-dist
 *
 * Cloudflare's Pages project runs exactly that command; this file is what turns
 * the repository root into the upload directory. `.assetsignore` is the list of
 * things that must not become public assets (tests, configs, the Functions
 * source, the Netlify-era code), so the same list drives this copy.
 *
 * Two exceptions are deliberate:
 *   _headers  Pages reads it from the upload directory to apply the CSP and
 *             cache rules. It is listed in .assetsignore so the file itself is
 *             not served, but it still has to travel with the build.
 *   functions Cloudflare looks for the Functions directory at the project root
 *             and bundles it itself; copying it into the assets would publish
 *             the router source at /functions/.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const assets = resolve(flag('--assets', '.'));
const out = resolve(flag('--out', '.pages-dist'));

// The output lives inside the assets root, and is removed before every build
// so a stale file from an earlier run cannot ride along. Refuse any path that
// could delete the repository (or something outside it).
if (out === assets || !out.startsWith(assets + sep)) {
  console.error(`Refusing to stage into ${out}: it must be a subdirectory of ${assets}.`);
  process.exit(1);
}

const ignoreFile = join(assets, '.assetsignore');
const ignores = readFileSync(ignoreFile, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => line.replace(/^\/+|\/+$/g, ''));

// Cloudflare needs these files even though they are not public assets.
const keep = new Set(['_headers']);
const ignored = ignores.filter((entry) => !keep.has(entry));
const alwaysIgnore = new Set(['.git', 'node_modules', '.wrangler', '.pages-dist', '.freebuff']);

const outRel = relative(assets, out);
const isIgnored = (relPath) => {
  const parts = relPath.split(sep);
  if (alwaysIgnore.has(parts[0])) return true;
  if (relPath === outRel || relPath.startsWith(outRel + sep)) return true;
  return ignored.some((entry) => {
    const entryParts = entry.split('/');
    return entryParts.every((part, i) => parts[i] === part);
  });
};

// fs.cpSync refuses to copy a directory into its own subdirectory, so walk
// the tree file by file and apply the ignore list as we go.
const copyTree = (from, to, relBase = '') => {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const relPath = relBase ? relBase + sep + entry.name : entry.name;
    if (isIgnored(relPath)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, relPath);
    else if (entry.isFile() || entry.isSymbolicLink()) copyFileSync(source, target);
  }
};

rmSync(out, { recursive: true, force: true });
copyTree(assets, out);

const count = (dir) => readdirSync(dir, { withFileTypes: true })
  .reduce((n, entry) => n + (entry.isDirectory() ? count(join(dir, entry.name)) : 1), 0);

console.log(`Staged ${count(out)} files into ${outRel}.`);
