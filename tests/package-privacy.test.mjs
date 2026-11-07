import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const equationAssets = [
  'public/equations.js',
  'public/vendor/katex/katex.min.js',
  'public/vendor/katex/katex.min.css',
  'public/vendor/katex/fonts/KaTeX_Math-Italic.woff2',
  'public/vendor/katex/LICENSE',
  'public/vendor/katex/vendor-manifest.json',
  'THIRD_PARTY_NOTICES.txt',
];
const privatePaths = [
  'data/diary.sqlite',
  'data/diary.sqlite-wal',
  'data/diary.sqlite-shm',
  'diary/diary.sqlite',
  'user-data/Default/Local Storage/leveldb/000001.log',
  'exports/A personal entry.html',
  'backups/Stillwater-backup-2026-10-31.json',
  'Stillwater-backup-2026-10-31.json',
  'private-diary.sqlite',
  'public/data/diary.sqlite',
  'public/backups/Stillwater-backup-today.json',
  'public/entry-backup.json',
  'public/error.log',
  'desktop/data/diary.db',
  'desktop/.env.local',
];

function gitExecutable() {
  const available = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (available.status === 0) return 'git';
  const bundled = path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe');
  if (existsSync(bundled)) return bundled;
  throw new Error('Git is needed to verify that personal diary files cannot be staged accidentally.');
}

test('Git ignores personal diary files and generated output while allowing application source', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stillwater-ignore-test-'));
  try {
    await copyFile(path.join(appDirectory, '.gitignore'), path.join(directory, '.gitignore'));
    const git = gitExecutable();
    const init = spawnSync(git, ['-C', directory, 'init', '--quiet'], { encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    const ignored = [...privatePaths, 'A personal entry.txt', 'node_modules/electron/dist/electron.exe', 'release/Stillwater.exe', 'build/error.log'];
    const result = spawnSync(git, ['-C', directory, 'check-ignore', '--no-index', '--stdin'], { input: ignored.join('\n') + '\n', encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/).sort(), ignored.sort());
    const source = ['README.md', 'package.json', 'pnpm-lock.yaml', 'server.mjs', 'desktop/main.cjs', 'public/app.js', 'public/math-symbols.js', 'public/math-symbols.css', 'build/icon.ico', '.github/workflows/windows.yml', ...equationAssets];
    const allowed = spawnSync(git, ['-C', directory, 'check-ignore', '--no-index', '--stdin'], { input: source.join('\n') + '\n', encoding: 'utf8', windowsHide: true });
    assert.equal(allowed.status, 1, `Application source must remain trackable: ${allowed.stdout} ${allowed.stderr}`);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('stillwater-ignore-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('the application package excludes diary data even inside otherwise allowed source folders', async () => {
  const manifest = JSON.parse(await readFile(path.join(appDirectory, 'package.json'), 'utf8'));
  const rules = manifest.build.files;
  assert.ok(Array.isArray(rules) && rules.every(rule => typeof rule === 'string'), 'Use an explicit, reviewable source file allowlist.');
  function included(file) {
    return rules.some(rule => !rule.startsWith('!') && path.posix.matchesGlob(file, rule))
      && !rules.some(rule => rule.startsWith('!') && path.posix.matchesGlob(file, rule.slice(1)));
  }
  for (const file of privatePaths) assert.equal(included(file), false, `${file} must never enter the desktop package`);
  for (const file of ['package.json', 'server.mjs', 'desktop/main.cjs', 'desktop/preload.cjs', 'public/index.html', 'public/app.js', 'public/styles.css', 'public/math-symbols.js', 'public/math-symbols.css', 'build/icon.ico', ...equationAssets]) {
    assert.equal(included(file), true, `${file} is required by the app`);
  }
  assert.equal(manifest.build.asar, true);
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false, 'Uninstalling must retain the personal diary.');
  assert.ok(manifest.scripts['build:win'].includes('--publish never'), 'Building must not publish a release implicitly.');
});

const archive = path.join(appDirectory, 'release/win-unpacked/resources/app.asar');
test('the built application archive contains no diary data, backups or development output', { skip: !existsSync(archive) }, async () => {
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
  const asar = appBuilderRequire('@electron/asar');
  const files = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
  const forbidden = /(^|\/)(?:data|diary|user-data|userdata|exports|backups|backup|node_modules|\.git)(?:\/|$)|\.(?:sqlite\d?|db\d?)(?:-|$)|(?:backup[^/]*\.json$)|\.log(?:\.|$)|\.(?:exe|dll|pfx|pem|key)$|(^|\/)\.env(?:\.|$)/i;
  assert.deepEqual(files.filter(file => forbidden.test(file)), []);
  for (const required of ['package.json', 'server.mjs', 'desktop/main.cjs', 'desktop/preload.cjs', 'public/index.html', 'public/app.js', 'public/math-symbols.js', 'public/math-symbols.css', ...equationAssets]) {
    assert.ok(files.includes(required), `Missing packaged app file: ${required}`);
  }
});
