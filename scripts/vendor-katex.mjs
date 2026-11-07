// Fetch only the reviewed browser assets from an integrity-verified npm archive.
// No package lifecycle scripts run, and no archive paths are extracted wholesale.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const version = '0.19.1';
const registry = `https://registry.npmjs.org/katex/${version}`;
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(app, 'public', 'vendor', 'katex');
const work = path.join(app, 'work', 'vendor-katex');
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `Download failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.byteLength < 30 * 1024 * 1024, 'Unexpectedly large dependency download.');
  return bytes;
}

const metadataBytes = await fetchBytes(registry);
const metadata = JSON.parse(metadataBytes.toString('utf8'));
assert.equal(metadata.name, 'katex');
assert.equal(metadata.version, version);
const archiveURL = new URL(metadata.dist.tarball);
assert.equal(archiveURL.origin, 'https://registry.npmjs.org');
assert.equal(archiveURL.pathname, `/katex/-/katex-${version}.tgz`);
const archive = await fetchBytes(archiveURL.href);
const integrity = `sha512-${digest(archive, 'sha512', 'base64')}`;
assert.equal(integrity, metadata.dist.integrity, 'npm archive integrity mismatch.');
const tar = gunzipSync(archive, { maxOutputLength: 50 * 1024 * 1024 });
const chosen = new Map();
const fixed = new Map([
  ['package/dist/katex.min.js', 'katex.min.js'],
  ['package/dist/katex.min.css', 'katex.min.css'],
  ['package/LICENSE', 'LICENSE'],
]);
const headerString = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');

for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const shortName = headerString(header.subarray(0, 100));
  const prefix = headerString(header.subarray(345, 500));
  const name = prefix ? `${prefix}/${shortName}` : shortName;
  const sizeField = headerString(header.subarray(124, 136)).trim();
  assert.match(sizeField, /^[0-7]+$/, 'Unsupported archive size encoding.');
  const size = parseInt(sizeField, 8);
  assert.ok(offset + 512 + size <= tar.length, 'Truncated dependency archive.');
  let relative = fixed.get(name);
  if (/^package\/dist\/fonts\/KaTeX_[A-Za-z0-9_-]+\.woff2$/.test(name)) relative = name.slice('package/dist/'.length);
  if (relative) {
    assert.ok(header[156] === 0 || header[156] === 48, `Expected a regular file: ${name}`);
    assert.ok(!chosen.has(relative), `Duplicate browser asset: ${name}`);
    chosen.set(relative, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
for (const name of fixed.values()) assert.ok(chosen.has(name), `Missing required asset: ${name}`);
assert.ok([...chosen.keys()].filter(name => name.endsWith('.woff2')).length >= 20, 'Missing math fonts.');

const originalCSS = chosen.get('katex.min.css').toString('utf8');
const offlineCSS = originalCSS.replace(/@font-face\{[^}]*\}/g, face => face.replace(/src:([^;}]+)/, (_match, sources) => {
  const source = sources.split(',').find(item => /\.woff2\)/.test(item));
  assert.ok(source, 'Every vendored font must provide a WOFF2 source.');
  return `src:${source}`;
}));
assert.ok(!/\.woff\)|\.ttf\)/.test(offlineCSS), 'Unexpected non-WOFF2 font reference.');
for (const match of offlineCSS.matchAll(/url\(([^)]+)\)/g)) {
  const asset = match[1].replace(/^['"]|['"]$/g, '');
  assert.ok(chosen.has(asset), `CSS refers to an unbundled asset: ${asset}`);
}
chosen.set('katex.min.css', Buffer.from(offlineCSS, 'utf8'));

await mkdir(work, { recursive: true });
await writeFile(path.join(work, `katex-${version}.tgz`), archive);
await writeFile(path.join(work, 'registry-metadata.json'), metadataBytes);
await mkdir(path.join(destination, 'fonts'), { recursive: true });
for (const [relative, bytes] of chosen) await writeFile(path.join(destination, relative), bytes);

const manifest = {
  name: 'KaTeX', version, registry, tarball: archiveURL.href, integrity,
  archiveSha256: digest(archive),
  license: 'MIT',
  modification: 'katex.min.css font sources are reduced to the bundled WOFF2 files. JavaScript and fonts are unmodified.',
  files: Object.fromEntries([...chosen].sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>[name,{bytes:bytes.byteLength,sha256:digest(bytes)}])),
};
await writeFile(path.join(destination, 'vendor-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(app, 'THIRD_PARTY_NOTICES.txt'), `Stillwater third-party components\n\nKaTeX ${version}\nSource: https://katex.org/\nDistribution: ${archiveURL.href}\nLicense: MIT (full license in public/vendor/katex/LICENSE)\n\nBundled browser assets and fonts support offline equation rendering.\nThe JavaScript and WOFF2 fonts are unmodified. The CSS font source lists\nhave been reduced to WOFF2 only, matching the bundled font files.\nThe npm archive is SHA-512 verified before extracting an explicit asset\nallowlist; its integrity and each bundled asset hash are recorded in\npublic/vendor/katex/vendor-manifest.json.\n\nTo reproduce: node scripts/vendor-katex.mjs\n`);
console.log(JSON.stringify({ version, files: chosen.size, integrity, archiveSha256: manifest.archiveSha256, destination }, null, 2));
