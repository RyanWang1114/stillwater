'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

/** Take a consistent SQLite snapshot, including committed WAL changes.
 *  The old diary remains untouched; a desktop diary is never overwritten. */
async function migrateLegacyDiary(candidates, targetDirectory) {
  fs.mkdirSync(targetDirectory, { recursive: true });
  const destination = path.join(targetDirectory, 'diary.sqlite');
  if (fs.existsSync(destination)) return { migrated: false, reason: 'desktop-diary-exists' };
  const source = [...new Set(candidates.map(p => path.resolve(p)))].find(p =>
    p !== destination && fs.existsSync(p) && fs.statSync(p).isFile());
  if (!source) return { migrated: false, reason: 'no-legacy-diary' };
  const temporary = path.join(targetDirectory, `migration-${process.pid}-${Date.now()}.sqlite`);
  const legacy = new DatabaseSync(source, { readOnly: true });
  try {
    if (legacy.prepare('PRAGMA user_version').get().user_version > 1) {
      throw new Error('This diary requires a newer version of Stillwater.');
    }
    const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    if (!['entries', 'attachments', 'notebooks', 'revisions'].every(name => tables.includes(name))) {
      throw new Error('The previous diary database is not a supported Stillwater diary.');
    }
    const integrity = legacy.prepare('PRAGMA quick_check').get();
    if (Object.values(integrity)[0] !== 'ok') throw new Error('The previous diary needs a database repair. Its files have been kept unchanged.');
    await backup(legacy, temporary);
    // COPYFILE_EXCL also protects against a second process creating a diary during migration.
    fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(targetDirectory, 'migration.json'), JSON.stringify({ version: 1, copiedAt: new Date().toISOString(), source }, null, 2));
    return { migrated: true, source };
  } finally {
    legacy.close();
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
module.exports = { migrateLegacyDiary };
