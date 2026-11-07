import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { migrateLegacyDiary } = require('../desktop/migration.cjs');
const appDirectory = fileURLToPath(new URL('..',import.meta.url));
const workDirectory = path.resolve(appDirectory,'work');

function createDiary(filename,version=1) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE notebooks(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE entries(id TEXT PRIMARY KEY,title TEXT NOT NULL,html TEXT NOT NULL,date TEXT NOT NULL);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,data BLOB NOT NULL);
    CREATE TABLE revisions(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE entry_tags(entry_id TEXT NOT NULL,tag_id INTEGER NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    PRAGMA user_version=${version};
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
  return db;
}
const digest = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');

test('desktop migration preserves legacy diary data and never overwrites an existing diary',{timeout:30_000},async t=>{
  await mkdir(workDirectory,{recursive:true});
  const testRoot = await mkdtemp(path.join(workDirectory,'stillwater-migration-test-'));
  try {
    await t.test('a consistent backup includes committed WAL writing and attachment bytes without changing the source',async()=>{
      const source = path.join(testRoot,'legacy-wal.sqlite');
      const target = path.join(testRoot,'wal-desktop');
      const legacy = createDiary(source);
      const attachment = Buffer.from([0,1,2,3,240,255,10,13]);
      try {
        legacy.exec('BEGIN IMMEDIATE');
        legacy.prepare('INSERT INTO entries(id,title,html,date) VALUES (?,?,?,?)').run('entry-1','Committed in WAL','<p>A test memory.</p>','2026-10-31');
        legacy.prepare('INSERT INTO attachments(id,entry_id,name,type,size,data) VALUES (?,?,?,?,?,?)').run('attachment-1','entry-1','test.bin','application/octet-stream',attachment.length,attachment);
        legacy.exec('COMMIT');

        // Prove the committed content is absent from the main file alone.
        // Keep the source connection open throughout migration so SQLite cannot
        // checkpoint the WAL as a side effect of closing the last connection.
        const mainOnly = path.join(testRoot,'main-file-only.sqlite');
        await copyFile(source,mainOnly);
        const incomplete = new DatabaseSync(mainOnly,{readOnly:true});
        try { assert.equal(incomplete.prepare('SELECT COUNT(*) AS n FROM entries').get().n,0); }
        finally { incomplete.close(); }
        assert.ok((await readFile(`${source}-wal`)).length>0);
        const mainHash = await digest(source), walHash = await digest(`${source}-wal`);

        const result = await migrateLegacyDiary([source],target);
        assert.deepEqual(result,{migrated:true,source});
        assert.equal(await digest(source),mainHash,'the source main database is unchanged');
        assert.equal(await digest(`${source}-wal`),walHash,'the source committed WAL bytes are unchanged');
        assert.equal(legacy.prepare('SELECT title FROM entries WHERE id=?').get('entry-1').title,'Committed in WAL');
        assert.deepEqual(Buffer.from(legacy.prepare('SELECT data FROM attachments WHERE id=?').get('attachment-1').data),attachment);

        const migrated = new DatabaseSync(path.join(target,'diary.sqlite'),{readOnly:true});
        try {
          assert.equal(migrated.prepare('SELECT title FROM entries WHERE id=?').get('entry-1').title,'Committed in WAL');
          assert.deepEqual(Buffer.from(migrated.prepare('SELECT data FROM attachments WHERE id=?').get('attachment-1').data),attachment);
          assert.equal(Object.values(migrated.prepare('PRAGMA quick_check').get())[0],'ok');
        } finally { migrated.close(); }
        const metadata = JSON.parse(await readFile(path.join(target,'migration.json'),'utf8'));
        assert.equal(metadata.source,source);
        assert.equal(metadata.version,1);
        assert.ok(Number.isFinite(Date.parse(metadata.copiedAt)));
        assert.ok(!(await readdir(target)).some(name=>/^migration-.*\.sqlite/.test(name)),'temporary snapshot was removed');
      } finally { legacy.close(); }
    });

    await t.test('an existing desktop diary is never overwritten, even when the candidate is malformed',async()=>{
      const target = path.join(testRoot,'existing-desktop');
      await mkdir(target);
      const destination = path.join(target,'diary.sqlite');
      const existing = createDiary(destination);
      existing.prepare('INSERT INTO entries(id,title,html,date) VALUES (?,?,?,?)').run('already-here','Keep this writing','<p>Existing desktop memory.</p>','2026-10-31');
      existing.close();
      const original = await readFile(destination);
      const source = path.join(testRoot,'malformed-ignored.sqlite');
      await writeFile(source,'not a SQLite database');
      assert.deepEqual(await migrateLegacyDiary([source],target),{migrated:false,reason:'desktop-diary-exists'});
      assert.deepEqual(await readFile(destination),original);
      assert.equal(existsSync(path.join(target,'migration.json')),false);
    });

    await t.test('a valid empty legacy schema is copied as an empty diary',async()=>{
      const source = path.join(testRoot,'empty.sqlite');
      const target = path.join(testRoot,'empty-desktop');
      const legacy = createDiary(source);
      try {
        assert.equal((await migrateLegacyDiary([source],target)).migrated,true);
        const migrated = new DatabaseSync(path.join(target,'diary.sqlite'),{readOnly:true});
        try {
          assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM entries').get().n,0);
          assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,1);
          assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'").get());
        } finally { migrated.close(); }
      } finally { legacy.close(); }
    });

    await t.test('a malformed database fails without creating a new diary or changing the source',async()=>{
      const source = path.join(testRoot,'malformed.sqlite');
      const target = path.join(testRoot,'malformed-desktop');
      const original = Buffer.from('This is deliberately not a SQLite database.');
      await writeFile(source,original);
      await assert.rejects(migrateLegacyDiary([source],target));
      assert.deepEqual(await readFile(source),original);
      assert.equal(existsSync(path.join(target,'diary.sqlite')),false);
      assert.deepEqual(await readdir(target),[]);
    });

    await t.test('an unrelated SQLite schema is rejected without creating a diary',async()=>{
      const source = path.join(testRoot,'unrelated.sqlite');
      const target = path.join(testRoot,'unrelated-desktop');
      const unrelated = new DatabaseSync(source);
      unrelated.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'keep me\');');
      unrelated.close();
      const original = await readFile(source);
      await assert.rejects(migrateLegacyDiary([source],target),/not a supported Stillwater diary/);
      assert.deepEqual(await readFile(source),original);
      assert.equal(existsSync(path.join(target,'diary.sqlite')),false);
      assert.deepEqual(await readdir(target),[]);
    });

    await t.test('a newer schema fails without downgrading or creating a desktop diary',async()=>{
      const source = path.join(testRoot,'newer.sqlite');
      const target = path.join(testRoot,'newer-desktop');
      const newer = createDiary(source,2);
      try {
        const original = await readFile(source);
        await assert.rejects(migrateLegacyDiary([source],target),/newer version/);
        assert.deepEqual(await readFile(source),original);
        assert.equal(newer.prepare('PRAGMA user_version').get().user_version,2);
        assert.equal(existsSync(path.join(target,'diary.sqlite')),false);
        assert.deepEqual(await readdir(target),[]);
      } finally { newer.close(); }
    });
  } finally {
    const resolved = path.resolve(testRoot);
    assert.ok(resolved.startsWith(path.resolve(workDirectory)+path.sep));
    assert.ok(path.basename(resolved).startsWith('stillwater-migration-test-'));
    await rm(resolved,{recursive:true,force:true});
  }
});
