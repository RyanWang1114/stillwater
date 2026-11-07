import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appDirectory = fileURLToPath(new URL('..',import.meta.url));
const workDirectory = path.resolve(appDirectory,'work');
const scenario = process.argv.find(value=>value.startsWith('--scenario='))?.split('=')[1];

if (scenario) {
  // The desktop backend must remain usable when opening any TCP server is
  // forbidden. This child has its own temporary database and module instance.
  const { default:net } = await import('node:net');
  const { default:http } = await import('node:http');
  net.Server.prototype.listen = () => { throw new Error('Desktop mode attempted to listen on a TCP port.'); };
  http.createServer = () => { throw new Error('Desktop mode attempted to create an HTTP server.'); };
  const sigint = process.listenerCount('SIGINT');
  const sigterm = process.listenerCount('SIGTERM');
  const {handleDesktopRequest,closeDatabase} = await import('../server.mjs');
  assert.equal(process.listenerCount('SIGINT'),sigint);
  assert.equal(process.listenerCount('SIGTERM'),sigterm);

  const request = (pathname,method='GET',data,extra={}) => new Request(`stillwater://app${pathname}`,{
    method,headers:{'Content-Type':'application/json','X-Diary-Request':'1',Origin:'stillwater://app',...extra},
    ...(data===undefined?{}:{body:JSON.stringify(data)}),
  });
  async function api(pathname,method='GET',data) {
    const response = await handleDesktopRequest(request(pathname,method,data));
    const result = await response.json();
    assert.ok(response.ok,`${method} ${pathname}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }

  try {
    assert.deepEqual(await api('/api/health'),{ok:true,app:'stillwater',version:1});
    const first = await api('/api/state');
    if (scenario === 'reopen') {
      assert.equal(first.entries.length,2,'both entries persist after an orderly desktop shutdown');
      assert.ok(first.entries.every(entry=>entry.title==='Desktop writing'));
      assert.ok(first.entries.every(entry=>entry.html.includes(entry.attachments[0].url)));
      assert.ok(first.entries.every(entry=>entry.html.includes('<span data-latex="T(n) = aT(n/b) + O(n^d)">T(n) = aT(n/b) + O(n^d)</span>')));
      for (const entry of first.entries) {
        const media = await handleDesktopRequest(request(entry.attachments[0].url));
        assert.equal(await media.text(),'Desktop attachment bytes.');
      }
      assert.equal(first.settings.goal,425);
      closeDatabase();
      closeDatabase();
      console.log('Desktop reopen and persistence passed.');
    } else {
      assert.deepEqual(first.entries,[]);
      const home = await handleDesktopRequest(request('/'));
      assert.equal(home.status,200);
      assert.match(home.headers.get('content-security-policy'),/default-src 'none'/);
      assert.match(await home.text(),/Stillwater/i);
      const head = await handleDesktopRequest(request('/app.js','HEAD'));
      assert.equal(head.status,200);
      assert.equal(await head.text(),'');

      const notebook = await api('/api/notebooks','POST',{name:'Desktop notebook'});
      const entry = await api('/api/entries','POST',{
        title:'Desktop writing',html:'<p>First words.</p>',date:'2026-10-31',tags:['desktop'],notebookId:notebook.id,mood:4,
      });
      const media = await api(`/api/entries/${entry.id}/attachments`,'POST',{
        name:'note.txt',type:'text/plain',data:Buffer.from('Desktop attachment bytes.').toString('base64'),
      });
      const attachment = await handleDesktopRequest(request(media.url));
      assert.equal(attachment.status,200);
      assert.match(attachment.headers.get('content-disposition'),/^attachment;/);
      assert.equal(await attachment.text(),'Desktop attachment bytes.');
      const attachmentHead = await handleDesktopRequest(request(media.url,'HEAD'));
      assert.equal(attachmentHead.status,200);
      assert.equal(Number(attachmentHead.headers.get('content-length')),25);
      assert.equal(await attachmentHead.text(),'');

      const html = `<p>Saved in the desktop app. <span data-latex="T(n) = aT(n/b) + O(n^d)">T(n) = aT(n/b) + O(n^d)</span></p><img src="${media.url}" alt="Local media">`;
      const updated = await api(`/api/entries/${entry.id}`,'PUT',{html});
      assert.equal(updated.html,html);
      await api(`/api/entries/${entry.id}/revisions`,'POST',{});
      await api(`/api/entries/${entry.id}`,'PUT',{html:'<p>Changed.</p>'});
      const checkpoint = (await api(`/api/entries/${entry.id}/revisions`)).find(revision=>revision.html===html);
      assert.ok(checkpoint);
      const restored = await api(`/api/entries/${entry.id}/revisions/${checkpoint.id}/restore`,'POST',{});
      assert.equal(restored.html,html);
      await api('/api/settings','PUT',{goal:425});

      const backup = await api('/api/backup');
      assert.equal(backup.attachments.length,1);
      const imported = await api('/api/import','POST',{backup});
      assert.equal(imported.imported,1);
      const entries = (await api('/api/state')).entries;
      assert.equal(entries.length,2);
      assert.notEqual(entries[0].id,entries[1].id);
      assert.notEqual(entries[0].attachments[0].id,entries[1].attachments[0].id);
      assert.ok(entries.every(item=>item.html.includes(item.attachments[0].url)));

      for (const url of ['https://app/api/state','http://127.0.0.1:47831/api/state','stillwater://other/api/state','stillwater://app:123/api/state']) {
        assert.equal((await handleDesktopRequest(new Request(url))).status,403,url);
      }
      for (const headers of [{Origin:'https://example.com'},{Origin:'http://127.0.0.1:47831'},{Host:'evil.example'},{'Sec-Fetch-Site':'cross-site'}]) {
        assert.equal((await handleDesktopRequest(request('/api/state','GET',undefined,headers))).status,403);
      }
      const missingHeader = new Request('stillwater://app/api/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      assert.equal((await handleDesktopRequest(missingHeader)).status,403);
      const oversized = request('/api/import','POST',{}, {'Content-Length':String(256*1024*1024+1)});
      assert.equal((await handleDesktopRequest(oversized)).status,413);
      const malformed = new Request('stillwater://app/api/entries',{method:'POST',headers:{'Content-Type':'application/json','X-Diary-Request':'1'},body:'{'});
      assert.equal((await handleDesktopRequest(malformed)).status,400);
      for (const pathname of ['/%2e%2e/server.mjs','/%2e%2e%5cserver.mjs','/.hidden','/%00']) {
        const response = await handleDesktopRequest(request(pathname));
        assert.ok([400,403,404].includes(response.status));
        assert.ok(!(await response.text()).includes('DatabaseSync'));
      }
      assert.equal((await api('/api/state')).entries.length,2,'rejected requests did not mutate the diary');
      closeDatabase();
      closeDatabase();
      assert.equal((await handleDesktopRequest(request('/api/state'))).status,503);
      console.log('Desktop protocol API, static assets, media, backup and security passed.');
    }
  } finally {
    closeDatabase();
  }
} else {
  test('desktop protocol works without a listening server and persists after shutdown',{timeout:60_000},async()=>{
    await mkdir(workDirectory,{recursive:true});
    const testRoot = await mkdtemp(path.join(workDirectory,'stillwater-desktop-test-'));
    async function runScenario(name) {
      const child = spawn(process.execPath,[fileURLToPath(import.meta.url),`--scenario=${name}`],{
        cwd:appDirectory,windowsHide:true,
        env:{...process.env,STILLWATER_DESKTOP:'1',PORT:'not-used-in-desktop-mode',DIARY_DATA_DIR:path.join(testRoot,'data')},
        stdio:['ignore','pipe','pipe'],
      });
      let output = '';
      child.stdout.on('data',value=>{output+=value;});
      child.stderr.on('data',value=>{output+=value;});
      const timer = setTimeout(()=>child.kill(),25_000);
      try {
        const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
        assert.equal(code,0,`${name} failed:\n${output}`);
      } finally { clearTimeout(timer); }
    }
    try {
      await runScenario('write');
      await runScenario('reopen');
    } finally {
      const resolved = path.resolve(testRoot);
      assert.ok(resolved.startsWith(path.resolve(workDirectory)+path.sep));
      assert.ok(path.basename(resolved).startsWith('stillwater-desktop-test-'));
      await rm(resolved,{recursive:true,force:true});
    }
  });
}
