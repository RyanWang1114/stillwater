import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(APP_DIR, 'public');
const DATA_DIR = resolve(process.env.DIARY_DATA_DIR || join(APP_DIR, 'data'));
const PORT = Number(process.env.PORT || 47831);
const DESKTOP_MODE = process.env.STILLWATER_DESKTOP === '1';
const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MAX_BODY = 256 * 1024 * 1024;
const VERSION = 1;
const DEFAULT_SETTINGS = { goal: 300, theme: 'paper', font: 'serif', fontSize: 19 };
if (!DESKTOP_MODE && (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535)) throw new Error('PORT must be a valid port number.');
mkdirSync(DATA_DIR, { recursive: true });
const dbPath = join(DATA_DIR, 'diary.sqlite');
const db = new DatabaseSync(dbPath);
let databaseClosed = false;
if (db.prepare('PRAGMA user_version').get().user_version > VERSION) {
  db.close();
  throw new Error('This diary was created by a newer version of Stillwater. Open it with that version to keep your data safe.');
}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', html TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL, mood INTEGER, notebook_id TEXT REFERENCES notebooks(id) ON DELETE SET NULL,
    favorite INTEGER NOT NULL DEFAULT 0, location TEXT NOT NULL DEFAULT '', weather TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, word_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(entry_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
  CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_revisions_entry ON revisions(entry_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_attachments_entry ON attachments(entry_id);
  PRAGMA user_version = 1;
`);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ApiError(status, message); };
const now = () => new Date().toISOString();
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 1000, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') fail(400, 'Expected a text value.');
  if (value.length > max) fail(400, `Text exceeds the ${max.toLocaleString()} character limit.`);
  return value.replace(/\u0000/g, '');
};
const esc = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'Use a valid date (YYYY-MM-DD).');
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0,10) !== value) fail(400, 'Use a valid calendar date.');
  return value;
}
function validTimestamp(value, fallback = now()) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Rebuild a small HTML vocabulary rather than accepting executable imported markup.
// Local media and ordinary web links are allowed; remote images never load.
const HTML_TAGS = new Set('p div br strong b em i u s strike h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code hr a img table thead tbody tfoot tr th td input label span sup sub'.split(' '));
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (full, code) => {
    if (code[0] !== '#') return ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'})[code.toLowerCase()];
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2),16) : parseInt(code.slice(1),10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  });
}
function sanitizeHtml(input) {
  let html = text(input, 2000000);
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe|object|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  return html.replace(/<[^>]*>/g, token => {
    const match = /^<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>$/i.exec(token);
    if (!match) return '';
    const tag = match[2].toLowerCase();
    if (!HTML_TAGS.has(tag)) return '';
    if (match[1]) return ['br','hr','img','input'].includes(tag) ? '' : `</${tag}>`;
    const attrs = Object.create(null);
    for (const a of match[3].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/g)) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    let safe = '';
    const attr = (name, value) => { safe += ` ${name}="${esc(value)}"`; };
    // Persist only the editable equation source. Its rendered markup is derived
    // by the client; this does not admit arbitrary MathML, SVG or HTML attributes.
    if (tag === 'span' && attrs['data-latex']?.trim() && attrs['data-latex'].length <= 4000) attr('data-latex', attrs['data-latex']);
    if (attrs.class && /^[\w\s-]{1,200}$/.test(attrs.class)) attr('class', attrs.class);
    if (attrs['data-checked'] === 'true' || attrs['data-checked'] === 'false') attr('data-checked', attrs['data-checked']);
    if (attrs['data-type'] && /^[\w-]{1,40}$/.test(attrs['data-type'])) attr('data-type', attrs['data-type']);
    if (attrs.style) {
      const align = /(?:^|;)\s*text-align\s*:\s*(left|right|center|justify)\s*(?:;|$)/i.exec(attrs.style);
      if (align) attr('style', `text-align: ${align[1].toLowerCase()}`);
    }
    if (tag === 'a' && attrs.href && /^(https?:\/\/|mailto:|#)/i.test(attrs.href)) {
      attr('href', attrs.href); attr('target', '_blank'); attr('rel', 'noopener noreferrer');
    }
    if (tag === 'img') {
      const src = attrs.src || '';
      if (!/^\/media\/[a-z0-9-]+$/i.test(src) && !/^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,[a-z0-9+/=\s]+$/i.test(src)) return '';
      attr('src', src);
      attr('alt', (attrs.alt || '').slice(0,1000));
      if (/^\d{1,4}$/.test(attrs.width || '')) attr('width', attrs.width);
    }
    if (tag === 'input') {
      attr('type', 'checkbox');
      if ('checked' in attrs) safe += ' checked';
      if ('disabled' in attrs) safe += ' disabled';
    }
    if (tag === 'td' || tag === 'th') {
      for (const name of ['rowspan','colspan']) if (/^[1-9]\d?$/.test(attrs[name] || '')) attr(name, attrs[name]);
    }
    return `<${tag}${safe}>`;
  });
}
function wordCount(html) {
  const value = html.replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/g,' ').replace(/&[a-z0-9#]+;/gi,'x').trim();
  return value ? (value.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) || []).length : 0;
}
function normalizeTags(tags) {
  if (!Array.isArray(tags) || tags.length > 50) fail(400, 'Tags must be a list with up to 50 items.');
  const seen = new Set();
  return tags.map(t => text(t, 80).trim().replace(/^#/, '')).filter(t => {
    const key = t.toLocaleLowerCase();
    if (!t || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function getTags(id) {
  return db.prepare('SELECT t.name FROM tags t JOIN entry_tags et ON et.tag_id=t.id WHERE et.entry_id=? ORDER BY t.name COLLATE NOCASE').all(id).map(r => r.name);
}
function setTags(id, tags) {
  db.prepare('DELETE FROM entry_tags WHERE entry_id=?').run(id);
  for (const name of tags) {
    db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)').run(name);
    const tag = db.prepare('SELECT id FROM tags WHERE name=? COLLATE NOCASE').get(name);
    db.prepare('INSERT OR IGNORE INTO entry_tags(entry_id,tag_id) VALUES (?,?)').run(id,tag.id);
  }
}
function attachmentObject(row) {
  return { id: row.id, entryId: row.entry_id, name: row.name, type: row.type, size: row.size, url: `/media/${row.id}`, createdAt: row.created_at };
}
function getAttachments(id) {
  return db.prepare('SELECT id,entry_id,name,type,size,created_at FROM attachments WHERE entry_id=? ORDER BY created_at').all(id).map(attachmentObject);
}
function entryObject(row) {
  return { id: row.id, title: row.title, html: row.html, date: row.date, mood: row.mood,
    notebookId: row.notebook_id, favorite: Boolean(row.favorite), location: row.location, weather: row.weather,
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, wordCount: row.word_count,
    tags: getTags(row.id), attachments: getAttachments(row.id) };
}
function getEntry(id) {
  const row = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
  if (!row) fail(404, 'Entry not found.');
  return entryObject(row);
}
function normalizeEntry(input, previous = {}) {
  if (!plainObject(input)) fail(400, 'Expected an entry object.');
  const merged = { title:'', html:'', date:localDate(), mood:null, notebookId:null, favorite:false, location:'', weather:'', tags:[], ...previous, ...input };
  const mood = merged.mood === '' || merged.mood === null ? null : merged.mood;
  if (mood !== null && (!Number.isInteger(mood) || mood < 1 || mood > 5)) fail(400, 'Mood must be a number from 1 to 5.');
  const notebookId = merged.notebookId || null;
  if (notebookId !== null && (typeof notebookId !== 'string' || !db.prepare('SELECT id FROM notebooks WHERE id=?').get(notebookId))) fail(400, 'Notebook not found.');
  const html = sanitizeHtml(merged.html);
  return { title:text(merged.title, 1000), html, date:validDate(merged.date), mood, notebookId,
    favorite:Boolean(merged.favorite), location:text(merged.location, 1000), weather:text(merged.weather, 500),
    tags:normalizeTags(merged.tags), wordCount:wordCount(html) };
}
function insertEntry(input, options = {}) {
  const e = normalizeEntry(input);
  const id = options.id || randomUUID();
  const createdAt = options.createdAt || now();
  const updatedAt = options.updatedAt || createdAt;
  db.prepare(`INSERT INTO entries(id,title,html,date,mood,notebook_id,favorite,location,weather,created_at,updated_at,deleted_at,word_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,e.title,e.html,e.date,e.mood,e.notebookId,Number(e.favorite),e.location,e.weather,createdAt,updatedAt,options.deletedAt || null,e.wordCount);
  setTags(id,e.tags);
  return getEntry(id);
}
const contentFields = ['title','html','date','mood','notebookId','favorite','location','weather','tags'];
function revisionPayload(entry) {
  return Object.fromEntries(contentFields.map(key => [key,entry[key]]));
}
function addRevision(entry, force = false) {
  const last = db.prepare('SELECT created_at FROM revisions WHERE entry_id=? ORDER BY created_at DESC LIMIT 1').get(entry.id);
  if (!force && last && Date.now() - Date.parse(last.created_at) < 60000) return;
  db.prepare('INSERT INTO revisions(id,entry_id,created_at,payload) VALUES (?,?,?,?)').run(randomUUID(),entry.id,now(),JSON.stringify(revisionPayload(entry)));
  db.prepare('DELETE FROM revisions WHERE entry_id=? AND id NOT IN (SELECT id FROM revisions WHERE entry_id=? ORDER BY created_at DESC LIMIT 50)').run(entry.id,entry.id);
}
function updateEntry(id, input, forceRevision = false) {
  const before = getEntry(id);
  const e = normalizeEntry(input, before);
  const changed = contentFields.some(key => JSON.stringify(before[key]) !== JSON.stringify(e[key]));
  if (!changed) return before;
  addRevision(before, forceRevision);
  db.prepare('UPDATE entries SET title=?,html=?,date=?,mood=?,notebook_id=?,favorite=?,location=?,weather=?,updated_at=?,word_count=? WHERE id=?')
    .run(e.title,e.html,e.date,e.mood,e.notebookId,Number(e.favorite),e.location,e.weather,now(),e.wordCount,id);
  setTags(id,e.tags);
  return getEntry(id);
}
function getRevisions(id) {
  getEntry(id);
  return db.prepare('SELECT * FROM revisions WHERE entry_id=? ORDER BY created_at DESC').all(id).map(row => ({id:row.id,entryId:row.entry_id,createdAt:row.created_at,...JSON.parse(row.payload)}));
}
function getSettings() {
  const settings = {...DEFAULT_SETTINGS};
  for (const row of db.prepare('SELECT key,value FROM settings').all()) settings[row.key] = JSON.parse(row.value);
  return settings;
}
function updateSettings(input) {
  if (!plainObject(input) || JSON.stringify(input).length > 100000) fail(400, 'Invalid settings.');
  for (const [key,rawValue] of Object.entries(input)) {
    let value = rawValue;
    if (!/^[a-z][a-zA-Z0-9_]{0,49}$/.test(key) || ['constructor','prototype','__proto__'].includes(key)) fail(400, 'Invalid setting name.');
    if (key === 'goal' && (!Number.isInteger(value) || value < 1 || value > 100000)) fail(400, 'Daily goal must be 1–100,000 words.');
    if (key === 'fontSize' && (!Number.isFinite(value) || value < 12 || value > 36)) fail(400, 'Font size must be 12–36.');
    if (key === 'theme' && !['paper','sepia','dark'].includes(value)) fail(400, 'Choose a supported theme.');
    if (key === 'font' && !['serif','sans'].includes(value)) fail(400, 'Choose a supported writing font.');
    if (key === 'lastBackup' && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) fail(400, 'Invalid backup timestamp.');
    if (key === 'templates') {
      if (!Array.isArray(value) || value.length > 200) fail(400, 'Templates must be a list with up to 200 items.');
      value = value.map(template => {
        if (!plainObject(template)) fail(400, 'Invalid template.');
        const name = text(template.name,100).trim();
        if (!name) fail(400, 'A template needs a name.');
        return { name, title:text(template.title,1000), html:sanitizeHtml(template.html ?? ''), caption:text(template.caption,500) };
      });
    }
    db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  }
  return getSettings();
}
function getState() {
  return { entries:db.prepare('SELECT * FROM entries ORDER BY date DESC,created_at DESC').all().map(entryObject),
    notebooks:db.prepare('SELECT * FROM notebooks ORDER BY name COLLATE NOCASE').all(),
    tags:db.prepare('SELECT name FROM tags ORDER BY name COLLATE NOCASE').all().map(t=>t.name),
    settings:getSettings(), version:VERSION,
    storage:{databaseBytes:existsSync(dbPath)?statSync(dbPath).size:0,attachmentBytes:db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM attachments').get().total} };
}
function decodeAttachment(input) {
  if (!plainObject(input)) fail(400, 'Expected an attachment.');
  const name = text(input.name,255,'attachment').trim() || 'attachment';
  const type = text(input.type,150,'application/octet-stream').toLowerCase().split(';')[0].trim() || 'application/octet-stream';
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) fail(400, 'Invalid attachment type.');
  if (typeof input.data !== 'string' || input.data.length > Math.ceil(MAX_ATTACHMENT/3)*4 + 4 || input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) fail(400, 'Invalid attachment data (maximum 20 MB per file).');
  const data = Buffer.from(input.data,'base64');
  if (data.length > MAX_ATTACHMENT) fail(413, 'Maximum attachment size is 20 MB.');
  return {name,type,data,size:data.length};
}
function insertAttachment(entryId, input, options = {}) {
  getEntry(entryId);
  const file = decodeAttachment(input);
  const id = options.id || randomUUID();
  db.prepare('INSERT INTO attachments(id,entry_id,name,type,size,data,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id,entryId,file.name,file.type,file.size,file.data,options.createdAt || now());
  return attachmentObject(db.prepare('SELECT id,entry_id,name,type,size,created_at FROM attachments WHERE id=?').get(id));
}
function backup() {
  return transaction(() => {
    const state = getState();
    return { format:'stillwater-backup',version:VERSION,exportedAt:now(),entries:state.entries,notebooks:state.notebooks,settings:state.settings,
      revisions:db.prepare('SELECT * FROM revisions ORDER BY created_at').all().map(row=>({id:row.id,entryId:row.entry_id,createdAt:row.created_at,...JSON.parse(row.payload)})),
      attachments:db.prepare('SELECT * FROM attachments ORDER BY created_at').all().map(row=>({...attachmentObject(row),data:Buffer.from(row.data).toString('base64')})) };
  });
}
function importBackup(value) {
  if (!plainObject(value) || value.format !== 'stillwater-backup' || value.version !== VERSION || !Array.isArray(value.entries) || !Array.isArray(value.notebooks) || !Array.isArray(value.attachments) || !Array.isArray(value.revisions)) fail(400,'This is not a supported Stillwater backup.');
  if (value.entries.length > 100000 || value.notebooks.length > 10000 || value.attachments.length > 100000 || value.revisions.length > 500000) fail(400,'This backup contains too many items.');
  const oldEntryIds = new Set(), oldAttachmentIds = new Set();
  for (const e of value.entries) {
    if (!plainObject(e) || typeof e.id !== 'string' || !/^[\w-]{1,100}$/.test(e.id) || oldEntryIds.has(e.id)) fail(400,'Backup contains invalid or duplicate entry IDs.');
    oldEntryIds.add(e.id);
  }
  for (const a of value.attachments) {
    if (!plainObject(a) || typeof a.id !== 'string' || !/^[\w-]{1,100}$/.test(a.id) || oldAttachmentIds.has(a.id) || !oldEntryIds.has(a.entryId)) fail(400,'Backup contains invalid attachments.');
    oldAttachmentIds.add(a.id);
    decodeAttachment(a);
  }
  return transaction(() => {
    const initiallyEmpty = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n === 0;
    const notebookMap = new Map(), entryMap = new Map(), attachmentMap = new Map();
    for (const n of value.notebooks) {
      if (!plainObject(n) || typeof n.id !== 'string' || notebookMap.has(n.id)) fail(400,'Backup contains invalid notebooks.');
      const name = text(n.name,100).trim();
      if (!name) fail(400,'A notebook name cannot be empty.');
      const sameName = db.prepare('SELECT id FROM notebooks WHERE name=? COLLATE NOCASE').get(name);
      if (sameName) { notebookMap.set(n.id,sameName.id); continue; }
      const id = /^[\w-]{1,100}$/.test(n.id) && !db.prepare('SELECT id FROM notebooks WHERE id=?').get(n.id) ? n.id : randomUUID();
      db.prepare('INSERT INTO notebooks(id,name) VALUES (?,?)').run(id,name); notebookMap.set(n.id,id);
    }
    for (const e of value.entries) entryMap.set(e.id, db.prepare('SELECT id FROM entries WHERE id=?').get(e.id) ? randomUUID() : e.id);
    for (const a of value.attachments) attachmentMap.set(a.id, db.prepare('SELECT id FROM attachments WHERE id=?').get(a.id) ? randomUUID() : a.id);
    const rewriteHtml = html => text(html,2000000).replace(/\/media\/([\w-]+)/g,(match,id)=>attachmentMap.has(id)?`/media/${attachmentMap.get(id)}`:match);
    for (const e of value.entries) {
      if (e.notebookId && !notebookMap.has(e.notebookId)) fail(400,'Backup references a missing notebook.');
      insertEntry({...e,html:rewriteHtml(e.html),notebookId:e.notebookId?notebookMap.get(e.notebookId):null},
        {id:entryMap.get(e.id),createdAt:validTimestamp(e.createdAt),updatedAt:validTimestamp(e.updatedAt),deletedAt:e.deletedAt?validTimestamp(e.deletedAt):null});
    }
    for (const a of value.attachments) insertAttachment(entryMap.get(a.entryId),a,{id:attachmentMap.get(a.id),createdAt:validTimestamp(a.createdAt)});
    for (const r of value.revisions) {
      if (!plainObject(r) || !entryMap.has(r.entryId)) fail(400,'Backup references an invalid revision.');
      const normalized = normalizeEntry({...r,html:rewriteHtml(r.html),notebookId:r.notebookId?(notebookMap.get(r.notebookId)||null):null});
      db.prepare('INSERT INTO revisions(id,entry_id,created_at,payload) VALUES (?,?,?,?)').run(randomUUID(),entryMap.get(r.entryId),validTimestamp(r.createdAt),JSON.stringify(revisionPayload(normalized)));
    }
    if (initiallyEmpty && plainObject(value.settings)) updateSettings(value.settings);
    return {ok:true,imported:value.entries.length,entries:[...entryMap.values()].map(getEntry)};
  });
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function headers(res, type = 'application/json; charset=utf-8') {
  res.setHeader('Content-Type',type);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',CSP);
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Permissions-Policy','geolocation=(), camera=(), microphone=(self)');
}
function json(res, data, status = 200) {
  headers(res); res.statusCode = status; res.end(JSON.stringify(data));
}
function validateRequest(req, transport) {
  const desktop = transport === 'desktop';
  const hosts = new Set(desktop ? ['app'] : [`127.0.0.1:${PORT}`,`localhost:${PORT}`]);
  if (!hosts.has(req.headers.host)) fail(403,'This app accepts local requests only.');
  const origin = req.headers.origin;
  const origins = desktop ? ['stillwater://app'] : [`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`];
  if (origin && !origins.includes(origin)) fail(403,'Cross-origin requests are not allowed.');
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403,'Cross-site requests are not allowed.');
  if (!['GET','HEAD'].includes(req.method) && req.headers['x-diary-request'] !== '1') fail(403,'Missing local request header.');
}
async function body(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) fail(413,'The file is too large. Backups must be smaller than 256 MB.');
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415,'Use a JSON request body.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413,'The file is too large. Backups must be smaller than 256 MB.');
    chunks.push(chunk);
  }
  try { const value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; if (!plainObject(value)) fail(400,'Expected a JSON object.'); return value; }
  catch { fail(400,'Invalid JSON.'); }
}
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const safeInlineTypes = /^(image\/(png|jpeg|webp|gif|bmp|avif)|audio\/(mpeg|mp3|mp4|ogg|wav|webm|x-wav)|video\/(mp4|webm|ogg)|application\/pdf)$/;
function serveAttachment(req,res,id) {
  const row = db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
  if (!row) fail(404,'Attachment not found.');
  const inline = safeInlineTypes.test(row.type);
  headers(res,inline?row.type:'application/octet-stream');
  res.setHeader('Content-Disposition',`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  res.setHeader('Content-Length',row.size);
  if (req.method === 'HEAD') res.end(); else res.end(Buffer.from(row.data));
}
function serveStatic(req,res,pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relative.includes('\0') || relative.split(/[\\/]/).some(p=>p==='..'||p.startsWith('.'))) fail(404,'File not found.');
  const file = resolve(PUBLIC_DIR,relative);
  if (!file.startsWith(PUBLIC_DIR+sep) || !existsSync(file) || !statSync(file).isFile()) fail(404,'File not found.');
  headers(res,MIME[extname(file).toLowerCase()]||'application/octet-stream');
  if (req.method === 'HEAD') res.end(); else res.end(readFileSync(file));
}

async function route(req,res,transport = 'http') {
  validateRequest(req,transport);
  if (databaseClosed) fail(503,'The diary is closed. Reopen Stillwater to continue.');
  let url;
  try { url = new URL(req.url,transport === 'desktop' ? 'stillwater://app' : `http://127.0.0.1:${PORT}`); }
  catch { fail(400,'Invalid URL.'); }
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { fail(400,'Invalid URL.'); }
  const method = req.method;
  if (method === 'OPTIONS') fail(405,'Method not allowed.');
  if (path === '/api/health' && method === 'GET') return json(res,{ok:true,app:'stillwater',version:VERSION});
  if (path === '/api/state' && method === 'GET') return json(res,getState());
  if (path === '/api/backup' && method === 'GET') {
    res.setHeader('Content-Disposition',`attachment; filename="stillwater-backup-${localDate()}.json"`);
    return json(res,backup());
  }
  if (path === '/api/import' && method === 'POST') {
    const input = await body(req);
    if (input.backup) return json(res,importBackup(input.backup));
    if (typeof input.text === 'string') {
      const html = text(input.text,1000000).split(/\r?\n/).map(line=>`<p>${esc(line)||'<br>'}</p>`).join('');
      const entry = transaction(()=>insertEntry({title:input.title||'',html,date:input.date||localDate()}));
      return json(res,{ok:true,imported:1,entries:[entry]},201);
    }
    fail(400,'Choose a Stillwater backup or a plain text file.');
  }
  if (path === '/api/entries' && method === 'POST') {
    const input = await body(req); return json(res,transaction(()=>insertEntry(input)),201);
  }
  let m = /^\/api\/entries\/([\w-]+)$/.exec(path);
  if (m) {
    if (method === 'GET') return json(res,getEntry(m[1]));
    if (method === 'PUT') { const input=await body(req);return json(res,transaction(()=>updateEntry(m[1],input))); }
    if (method === 'DELETE') {
      transaction(()=>{const entry=getEntry(m[1]);if(!entry.deletedAt) db.prepare('UPDATE entries SET deleted_at=?,updated_at=? WHERE id=?').run(now(),now(),m[1]);});
      return json(res,{ok:true});
    }
  }
  m = /^\/api\/entries\/([\w-]+)\/restore$/.exec(path);
  if (m && method === 'POST') {
    return json(res,transaction(()=>{getEntry(m[1]);db.prepare('UPDATE entries SET deleted_at=NULL,updated_at=? WHERE id=?').run(now(),m[1]);return getEntry(m[1]);}));
  }
  m = /^\/api\/entries\/([\w-]+)\/permanent$/.exec(path);
  if (m && method === 'DELETE') {
    transaction(()=>{const entry=getEntry(m[1]);if(!entry.deletedAt) fail(409,'Move the entry to trash before deleting it permanently.');db.prepare('DELETE FROM entries WHERE id=?').run(m[1]);});
    return json(res,{ok:true});
  }
  if (path === '/api/trash/empty' && method === 'POST') {
    const count=transaction(()=>db.prepare('DELETE FROM entries WHERE deleted_at IS NOT NULL').run().changes);
    return json(res,{ok:true,deleted:count});
  }
  m = /^\/api\/entries\/([\w-]+)\/revisions$/.exec(path);
  if (m && method === 'GET') return json(res,getRevisions(m[1]));
  if (m && method === 'POST') {
    transaction(()=>addRevision(getEntry(m[1]),true));
    return json(res,{ok:true});
  }
  m = /^\/api\/entries\/([\w-]+)\/revisions\/([\w-]+)\/restore$/.exec(path);
  if (m && method === 'POST') {
    return json(res,transaction(()=>{const row=db.prepare('SELECT payload FROM revisions WHERE id=? AND entry_id=?').get(m[2],m[1]);if(!row) fail(404,'Revision not found.');const data=JSON.parse(row.payload);if(data.notebookId&&!db.prepare('SELECT id FROM notebooks WHERE id=?').get(data.notebookId)) data.notebookId=null;return updateEntry(m[1],data,true);}));
  }
  m = /^\/api\/entries\/([\w-]+)\/attachments$/.exec(path);
  if (m && method === 'POST') {
    const input=await body(req);return json(res,transaction(()=>insertAttachment(m[1],input)),201);
  }
  m = /^\/api\/attachments\/([\w-]+)$/.exec(path);
  if (m && method === 'DELETE') {
    transaction(()=>{const row=db.prepare('SELECT id,entry_id FROM attachments WHERE id=?').get(m[1]);if(!row) fail(404,'Attachment not found.');db.prepare('DELETE FROM attachments WHERE id=?').run(m[1]);});
    return json(res,{ok:true});
  }
  if (path === '/api/notebooks' && method === 'POST') {
    const input=await body(req),name=text(input.name,100).trim();if(!name) fail(400,'Enter a notebook name.');
    if(db.prepare('SELECT id FROM notebooks WHERE name=? COLLATE NOCASE').get(name)) fail(409,'A notebook with this name already exists.');
    const notebook={id:randomUUID(),name};db.prepare('INSERT INTO notebooks(id,name) VALUES (?,?)').run(notebook.id,name);return json(res,notebook,201);
  }
  m = /^\/api\/notebooks\/([\w-]+)$/.exec(path);
  if(m) {
    if(method==='PUT') {
      const input=await body(req),name=text(input.name,100).trim();if(!name)fail(400,'Enter a notebook name.');
      if(!db.prepare('SELECT id FROM notebooks WHERE id=?').get(m[1]))fail(404,'Notebook not found.');
      if(db.prepare('SELECT id FROM notebooks WHERE name=? COLLATE NOCASE AND id<>?').get(name,m[1]))fail(409,'A notebook with this name already exists.');
      db.prepare('UPDATE notebooks SET name=? WHERE id=?').run(name,m[1]);return json(res,{id:m[1],name});
    }
    if(method==='DELETE') {if(!db.prepare('DELETE FROM notebooks WHERE id=?').run(m[1]).changes)fail(404,'Notebook not found.');return json(res,{ok:true});}
  }
  if(path==='/api/tags'&&method==='PUT') {
    const input=await body(req),from=text(input.from,80).trim(),to=text(input.to,80).trim().replace(/^#/,'');
    if(!from||!to)fail(400,'Enter both tag names.');
    transaction(()=>{const old=db.prepare('SELECT id FROM tags WHERE name=? COLLATE NOCASE').get(from);if(!old)fail(404,'Tag not found.');const target=db.prepare('SELECT id FROM tags WHERE name=? COLLATE NOCASE').get(to);if(target&&target.id!==old.id){db.prepare('INSERT OR IGNORE INTO entry_tags(entry_id,tag_id) SELECT entry_id,? FROM entry_tags WHERE tag_id=?').run(target.id,old.id);db.prepare('DELETE FROM tags WHERE id=?').run(old.id);}else db.prepare('UPDATE tags SET name=? WHERE id=?').run(to,old.id);});return json(res,{ok:true});
  }
  m = /^\/api\/tags\/(.+)$/.exec(path);
  if(m&&method==='DELETE') {db.prepare('DELETE FROM tags WHERE name=? COLLATE NOCASE').run(m[1]);return json(res,{ok:true});}
  if(path==='/api/settings'&&method==='PUT') {const input=await body(req);return json(res,transaction(()=>updateSettings(input)));}
  m = /^\/media\/([\w-]+)$/.exec(path);
  if(m&&['GET','HEAD'].includes(method)) return serveAttachment(req,res,m[1]);
  if(path.startsWith('/api/')||path.startsWith('/media/')) fail(404,'Not found.');
  if(['GET','HEAD'].includes(method)) return serveStatic(req,res,path);
  fail(405,'Method not allowed.');
}

function requestError(res,error) {
  if(res.headersSent){res.destroy();return;}
  if(error instanceof ApiError) return json(res,{error:error.message},error.status);
  console.error('Request failed:',error.message);
  json(res,{error:'The operation could not be completed. Your saved entries have not been discarded.'},500);
}

/** Flush the WAL and close the database. Safe to call more than once at app shutdown. */
export function closeDatabase() {
  if (databaseClosed) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  finally { db.close(); databaseClosed = true; }
}

/**
 * Electron protocol adapter. No socket, listening port, or renderer Node access
 * is involved. The transport value is supplied here, never by request headers.
 * Configure STILLWATER_DESKTOP=1 before importing this module.
 */
export async function handleDesktopRequest(request) {
  const responseHeaders = new Headers();
  let responseBody = null;
  const res = {
    statusCode: 200, headersSent: false,
    setHeader(name,value) { responseHeaders.set(name,String(value)); },
    end(value) { responseBody = value === undefined ? null : value; this.headersSent = true; },
    destroy() { responseBody = null; this.statusCode = 500; this.headersSent = true; },
  };
  let req;
  try {
    if (!DESKTOP_MODE) fail(403,'The desktop protocol is not enabled.');
    let url;
    try { url = new URL(request.url); } catch { fail(400,'Invalid URL.'); }
    if (url.protocol !== 'stillwater:' || url.hostname !== 'app' || url.port || url.username || url.password) fail(403,'This app accepts its own desktop requests only.');
    req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
    req.method = String(request.method || 'GET').toUpperCase();
    req.url = `${url.pathname || '/'}${url.search}`;
    req.headers = Object.fromEntries(request.headers);
    // Electron supplies the host in the Request URL. A manually supplied Host
    // must still match rather than overriding the URL validation above.
    req.headers.host ??= url.host;
    await route(req,res,'desktop');
  } catch(error) {
    requestError(res,error);
  } finally {
    // Cancel bodies rejected by header/path validation without buffering them.
    if (req && !req.readableEnded) req.destroy();
  }
  return new Response(request.method === 'HEAD' ? null : responseBody, {
    status:res.statusCode, headers:responseHeaders,
  });
}

if (!DESKTOP_MODE) {
  const server = http.createServer((req,res)=>{
    route(req,res).catch(error=>requestError(res,error));
  });
  server.requestTimeout=120000;
  server.headersTimeout=15000;
  server.on('error',error=>{
    console.error(error.code==='EADDRINUSE'?`Port ${PORT} is already in use. Open http://127.0.0.1:${PORT} or choose another PORT.`:`Stillwater could not start: ${error.message}`);
    closeDatabase();process.exitCode=1;
  });
  server.listen(PORT,'127.0.0.1',()=>{
    console.log(`Stillwater is ready at http://127.0.0.1:${PORT}`);
    console.log(`Local diary database: ${dbPath}`);
  });
  function shutdown(){server.close(()=>{closeDatabase();process.exit(0);});setTimeout(()=>process.exit(0),5000).unref();}
  process.on('SIGINT',shutdown);
  process.on('SIGTERM',shutdown);
}
