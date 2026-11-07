import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const workDirectory = path.resolve(appDirectory, 'work');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function vacantPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(dataDirectory) {
  const port = await vacantPort();
  let output = '';
  const child = spawn(process.execPath, [path.join(appDirectory, 'server.mjs')], {
    cwd: appDirectory,
    env: { ...process.env, PORT: String(port), DIARY_DATA_DIR: dataDirectory },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const base = `http://127.0.0.1:${port}`;
  let lastError = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return { child, base, port };
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) { lastError = `${error.message} ${error.cause?.message || ''}`; }
    await sleep(75);
  }
  child.kill();
  throw new Error(`Server did not start: ${output}\nReadiness error: ${lastError}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const ended = new Promise(resolve => server.child.once('exit', resolve));
  server.child.kill();
  await ended;
}

async function api(server, url, options = {}) {
  const response = await fetch(server.base + url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Diary-Request': '1',
      ...(options.headers || {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

function rawRequest(server, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.port, path: requestPath, headers }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('math symbols and superscript/subscript survive save, restart, revision recovery and backup', { timeout: 60_000 }, async () => {
  await mkdir(workDirectory, { recursive: true });
  const testRoot = await mkdtemp(path.join(workDirectory, 'stillwater-test-math-'));
  let server;
  let restoredServer;
  const originalHtml = '<p>数学: ∑ ∫ √ ∞ ± × ÷ ≠ ≤ ≥ α β π θ ∈ ∪ ∩ → ⇔ ℝ ½</p><p>E = mc<sup>2</sup>; a<sub>n</sub> = n<sup>2</sup></p>';
  const editedHtml = originalHtml + '<p>∀ x ∈ ℝ, x<sup>2</sup> ≥ 0; ∂f/∂x ≈ Δf/Δx.</p>';
  try {
    server = await startServer(path.join(testRoot, 'original'));
    const entry = await api(server, '/api/entries', {
      method: 'POST', body: { title: 'Math notes — π & ∞', html: originalHtml, date: '2026-10-31' },
    });
    assert.equal(entry.html, originalHtml, 'creation must keep Unicode and semantic script tags');
    const edited = await api(server, `/api/entries/${entry.id}`, { method: 'PUT', body: { html: editedHtml } });
    assert.equal(edited.html, editedHtml, 'autosave must keep the mathematical notation');

    await stopServer(server);
    server = await startServer(path.join(testRoot, 'original'));
    const reopened = (await api(server, '/api/state')).entries.find(item => item.id === entry.id);
    assert.equal(reopened.title, entry.title);
    assert.equal(reopened.html, editedHtml, 'notation must survive a database reopen');
    const revisions = await api(server, `/api/entries/${entry.id}/revisions`);
    const originalRevision = revisions.find(item => item.html === originalHtml);
    assert.ok(originalRevision, 'revision history must preserve the original notation');
    const recovered = await api(server, `/api/entries/${entry.id}/revisions/${originalRevision.id}/restore`, { method: 'POST', body: {} });
    assert.equal(recovered.html, originalHtml);

    const backup = await api(server, '/api/backup');
    assert.equal(backup.entries[0].html, originalHtml);
    assert.ok(backup.revisions.some(item => item.html === editedHtml), 'backup must also preserve the pre-recovery notation');
    restoredServer = await startServer(path.join(testRoot, 'restored'));
    const result = await api(restoredServer, '/api/import', { method: 'POST', body: { backup } });
    assert.equal(result.imported, 1);
    const restored = (await api(restoredServer, '/api/state')).entries[0];
    assert.equal(restored.title, entry.title);
    assert.equal(restored.html, originalHtml, 'backup import must not flatten script tags or replace symbols');
    assert.ok((await api(restoredServer, `/api/entries/${restored.id}/revisions`)).some(item => item.html === editedHtml));
  } finally {
    await stopServer(server);
    await stopServer(restoredServer);
    const resolved = path.resolve(testRoot);
    assert.ok(resolved.startsWith(path.resolve(workDirectory) + path.sep));
    assert.ok(path.basename(resolved).startsWith('stillwater-test-math-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('equation source survives saving, restart and backup without permitting rendered markup', { timeout: 60_000 }, async () => {
  await mkdir(workDirectory, { recursive: true });
  const testRoot = await mkdtemp(path.join(workDirectory, 'stillwater-test-equations-'));
  let server;
  let restoredServer;
  const latex = String.raw`T(n) = aT(\frac{n}{b}) + O(n^d),\quad x < y,\quad \text{"A & B's"}`;
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const equation = `<span data-latex="${escape(latex)}">${escape(latex)}</span>`;
  const html = `<p>My recurrence: ${equation}. Ordinary writing stays ordinary.</p>`;
  try {
    server = await startServer(path.join(testRoot, 'original'));
    const entry = await api(server, '/api/entries', { method: 'POST', body: { title: 'Equation notes', html, date: '2026-10-31' } });
    assert.equal(entry.html, html, 'LaTeX source, escaped punctuation and fallback text remain intact');
    await api(server, `/api/entries/${entry.id}`, { method: 'PUT', body: { html: html + '<p>A second thought.</p>' } });
    await stopServer(server);
    server = await startServer(path.join(testRoot, 'original'));
    assert.equal((await api(server, '/api/state')).entries.find(item => item.id === entry.id).html, html + '<p>A second thought.</p>');
    const revisions = await api(server, `/api/entries/${entry.id}/revisions`);
    const revision = revisions.find(item => item.html === html);
    assert.ok(revision, 'revision history keeps the editable source');
    await api(server, `/api/entries/${entry.id}/revisions/${revision.id}/restore`, { method: 'POST', body: {} });
    const backup = await api(server, '/api/backup');
    assert.equal(backup.entries[0].html, html);
    restoredServer = await startServer(path.join(testRoot, 'restored'));
    await api(restoredServer, '/api/import', { method: 'POST', body: { backup } });
    assert.equal((await api(restoredServer, '/api/state')).entries[0].html, html, 'backup restore keeps exact equation source');

    const limit = 'x'.repeat(4000);
    const boundary = await api(server, '/api/entries', { method: 'POST', body: { html: `<span data-latex="${limit}">${limit}</span>` } });
    assert.equal(boundary.html, `<span data-latex="${limit}">${limit}</span>`, 'the documented source length limit is supported');
    const untrusted = '<span data-latex="x^2" onclick="alert(1)" contenteditable="true" style="background:url(https://example.com)">x^2</span>'
      + '<p data-latex="y">text</p><span data-latex=" ">blank</span>'
      + `<span data-latex="${limit}x">too long</span>`
      + '<math><mi>x</mi></math><svg><text>x</text></svg><script>alert(1)</script>';
    const clean = await api(server, '/api/entries', { method: 'POST', body: { html: untrusted } });
    assert.equal(clean.html, '<span data-latex="x^2">x^2</span><p>text</p><span>blank</span><span>too long</span>', 'equation metadata does not relax HTML sanitation');
  } finally {
    await stopServer(server);
    await stopServer(restoredServer);
    const resolved = path.resolve(testRoot);
    assert.ok(resolved.startsWith(path.resolve(workDirectory) + path.sep));
    assert.ok(path.basename(resolved).startsWith('stillwater-test-equations-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('diary preserves writing, revisions and attachments through recovery and backup', { timeout: 60_000 }, async t => {
  await mkdir(workDirectory, { recursive: true });
  const testRoot = await mkdtemp(path.join(workDirectory, 'stillwater-test-'));
  let server;
  let restoredServer;
  try {
    server = await startServer(path.join(testRoot, 'original'));
    const empty = await api(server, '/api/state');
    assert.deepEqual(empty.entries, [], 'a new diary starts empty, without fake personal entries');

    const notebook = await api(server, '/api/notebooks', { method: 'POST', body: { name: 'Travel / Japan' } });
    const entry = await api(server, '/api/entries', {
      method: 'POST',
      body: {
        title: 'Evening in Kyoto', html: '<p>A quiet walk by the river.</p>', date: '2026-10-30',
        mood: 4, tags: ['travel', 'quiet'], notebookId: notebook.id, favorite: true, location: 'Kyoto',
      },
    });
    assert.ok(entry.id);
    assert.equal(entry.title, 'Evening in Kyoto');
    assert.equal(entry.notebookId, notebook.id);
    assert.deepEqual(entry.tags.sort(), ['quiet', 'travel']);
    assert.ok(entry.createdAt);
    assert.ok(entry.updatedAt);

    await t.test('autosaved edits can be recovered from a revision', async () => {
      const changed = await api(server, `/api/entries/${entry.id}`, {
        method: 'PUT', body: { title: 'Kyoto after sunset', html: '<p>Lanterns reflected on the water.</p>' },
      });
      assert.equal(changed.createdAt, entry.createdAt);
      assert.equal(changed.html, '<p>Lanterns reflected on the water.</p>');
      const revisions = await api(server, `/api/entries/${entry.id}/revisions`);
      const previous = revisions.find(revision => revision.html === entry.html);
      assert.ok(previous, 'the original writing has a recoverable revision');
      const recovered = await api(server, `/api/entries/${entry.id}/revisions/${previous.id}/restore`, { method: 'POST', body: {} });
      assert.equal(recovered.html, entry.html);
      assert.equal(recovered.title, entry.title);
    });

    const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=';
    const attachment = await api(server, `/api/entries/${entry.id}/attachments`, {
      method: 'POST', body: { name: 'river.png', type: 'image/png', data: imageData },
    });
    await api(server, `/api/entries/${entry.id}`, {
      method: 'PUT', body: { html: `<p>A quiet walk by the river.</p><img src="${attachment.url}" alt="River">` },
    });

    await t.test('local attachments round-trip byte-for-byte', async () => {
      const response = await fetch(server.base + attachment.url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type').split(';')[0], 'image/png');
      assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), imageData);
    });

    await t.test('format conversion checkpoints keep the latest rich text despite autosave throttling', async () => {
      const before = (await api(server, '/api/state')).entries.find(item => item.id === entry.id);
      await api(server, `/api/entries/${entry.id}/revisions`, { method: 'POST', body: {} });
      await api(server, `/api/entries/${entry.id}`, { method: 'PUT', body: { html: '<p>Plain converted writing.</p>' } });
      const revisions = await api(server, `/api/entries/${entry.id}/revisions`);
      const checkpoint = revisions.find(item => item.html === before.html);
      assert.ok(checkpoint, 'the exact pre-conversion HTML remains recoverable');
      const restored = await api(server, `/api/entries/${entry.id}/revisions/${checkpoint.id}/restore`, { method: 'POST', body: {} });
      assert.equal(restored.html, before.html);
    });

    await t.test('custom templates round-trip safely and malformed template settings are rejected', async () => {
      const settings = await api(server, '/api/settings', { method: 'PUT', body: { templates: [{ name: 'Evening', title: 'Daily reflection', html: '<h2>Good things</h2><script>alert(1)</script><p>A moment.</p>', caption: 'My template' }] } });
      assert.equal(settings.templates.length, 1);
      assert.ok(settings.templates[0].html.includes('<h2>Good things</h2>'));
      assert.ok(!settings.templates[0].html.includes('<script>'));
      const response = await fetch(server.base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Diary-Request': '1' }, body: JSON.stringify({ templates: 'broken' }) });
      assert.equal(response.status, 400);
      assert.equal((await api(server, '/api/state')).settings.templates.length, 1);
    });

    await t.test('tag rename, merge and notebook removal keep entry content', async () => {
      await api(server, '/api/tags', { method: 'PUT', body: { from: 'quiet', to: 'travel' } });
      const state = await api(server, '/api/state');
      assert.deepEqual(state.entries.find(item => item.id === entry.id).tags, ['travel']);
      await api(server, `/api/notebooks/${notebook.id}`, { method: 'DELETE' });
      const moved = (await api(server, '/api/state')).entries.find(item => item.id === entry.id);
      assert.equal(moved.notebookId, null);
      assert.ok(moved.html.includes(attachment.url));
    });

    await t.test('trash is reversible and does not remove attached files', async () => {
      await api(server, `/api/entries/${entry.id}`, { method: 'DELETE' });
      assert.ok((await api(server, '/api/state')).entries.find(item => item.id === entry.id).deletedAt);
      assert.equal((await fetch(server.base + attachment.url)).status, 200);
      await api(server, `/api/entries/${entry.id}/restore`, { method: 'POST', body: {} });
      assert.equal((await api(server, '/api/state')).entries.find(item => item.id === entry.id).deletedAt, null);
    });

    await api(server, '/api/settings', { method: 'PUT', body: { goal: 650, theme: 'dark', fontSize: 21 } });
    await t.test('saved content and settings survive a server restart', async () => {
      await stopServer(server);
      server = await startServer(path.join(testRoot, 'original'));
      const state = await api(server, '/api/state');
      const saved = state.entries.find(item => item.id === entry.id);
      assert.equal(saved.title, entry.title);
      assert.ok(saved.html.includes(attachment.url));
      assert.equal(saved.favorite, true);
      assert.equal(saved.mood, 4);
      assert.equal(state.settings.goal, 650);
      assert.equal(state.settings.theme, 'dark');
      assert.equal((await fetch(server.base + attachment.url)).status, 200);
    });

    const backup = await api(server, '/api/backup');
    await t.test('a full backup restores entries, images and revisions into a fresh diary', async () => {
      assert.equal(backup.format, 'stillwater-backup');
      assert.ok(backup.attachments.length);
      assert.ok(backup.revisions.length);
      restoredServer = await startServer(path.join(testRoot, 'restored'));
      const result = await api(restoredServer, '/api/import', { method: 'POST', body: { backup } });
      assert.equal(result.imported, 1);
      const state = await api(restoredServer, '/api/state');
      assert.equal(state.entries.length, 1);
      const restored = state.entries[0];
      assert.equal(restored.title, entry.title);
      assert.equal(restored.attachments.length, 1);
      const response = await fetch(restoredServer.base + restored.attachments[0].url);
      assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), imageData);
      assert.ok(restored.html.includes(restored.attachments[0].url));
      assert.ok((await api(restoredServer, `/api/entries/${restored.id}/revisions`)).length);
    });

    await t.test('importing into an existing diary preserves both copies and remaps images', async () => {
      await api(restoredServer, '/api/import', { method: 'POST', body: { backup } });
      const state = await api(restoredServer, '/api/state');
      assert.equal(state.entries.length, 2);
      assert.equal(new Set(state.entries.map(item => item.id)).size, 2);
      assert.equal(new Set(state.entries.map(item => item.attachments[0].id)).size, 2);
      for (const item of state.entries) {
        assert.ok(item.html.includes(item.attachments[0].url));
        assert.equal((await fetch(restoredServer.base + item.attachments[0].url)).status, 200);
      }
    });

    await t.test('permanent deletion removes only the chosen entry and its media', async () => {
      const state = await api(restoredServer, '/api/state');
      const doomed = state.entries[0];
      const survivor = state.entries[1];
      await api(restoredServer, `/api/entries/${doomed.id}`, { method: 'DELETE' });
      await api(restoredServer, `/api/entries/${doomed.id}/permanent`, { method: 'DELETE' });
      assert.equal((await api(restoredServer, '/api/state')).entries.length, 1);
      assert.equal((await fetch(restoredServer.base + doomed.attachments[0].url)).status, 404);
      assert.equal((await fetch(restoredServer.base + survivor.attachments[0].url)).status, 200);
    });

    await t.test('plain-text imports preserve special characters as text', async () => {
      const result = await api(server, '/api/import', { method: 'POST', body: { text: 'Hello <script>alert(1)</script> & goodbye', title: 'Old note', date: '2020-02-29' } });
      const imported = result.entries[0];
      assert.equal(imported.date, '2020-02-29');
      assert.ok(!imported.html.includes('<script>'));
      assert.ok(imported.html.includes('&lt;script&gt;'));
    });

    await t.test('cross-origin writes and invalid dates are rejected', async () => {
      const missingHeader = await fetch(server.base + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(missingHeader.status, 403);
      const hostileOrigin = await fetch(server.base + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Diary-Request': '1', Origin: 'https://example.com' }, body: '{}' });
      assert.equal(hostileOrigin.status, 403);
      const badHost = await rawRequest(server, '/api/state', { Host: 'evil.example' });
      assert.equal(badHost.status, 403);
      const invalidDate = await fetch(server.base + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Diary-Request': '1' }, body: JSON.stringify({ title: 'Bad date', date: '2026-02-30' }) });
      assert.equal(invalidDate.status, 400);
      const traversal = await rawRequest(server, '/%2e%2e/server.mjs', {});
      assert.ok([400, 403, 404].includes(traversal.status));
      assert.ok(!traversal.body.includes('DatabaseSync'));
    });
  } finally {
    await stopServer(server);
    await stopServer(restoredServer);
    const resolved = path.resolve(testRoot);
    assert.ok(resolved.startsWith(path.resolve(workDirectory) + path.sep));
    assert.ok(path.basename(resolved).startsWith('stillwater-test-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
