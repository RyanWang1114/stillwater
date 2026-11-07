'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { migrateLegacyDiary } = require('./migration.cjs');

const APP_URL = 'stillwater://app/';
const debug = message => { if (process.env.STILLWATER_DEBUG) console.error('[Stillwater]', message); };
const projectDirectory = path.resolve(__dirname, '..');
app.setName('Stillwater');
app.setAppUserModelId('com.stillwater.diary');
const profileDirectory = process.env.STILLWATER_USER_DATA
  ? path.resolve(process.env.STILLWATER_USER_DATA)
  : path.join(app.getPath('appData'), 'Stillwater');
fs.mkdirSync(profileDirectory, { recursive: true });
app.setPath('userData', profileDirectory);
const sessionDirectory = path.join(profileDirectory, 'browser');
fs.mkdirSync(sessionDirectory, { recursive: true });
app.setPath('sessionData', sessionDirectory);
const dataDirectory = path.join(profileDirectory, 'diary');

protocol.registerSchemesAsPrivileged([{ scheme: 'stillwater', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true
} }]);

let mainWindow, backend, closeToken, closeTimer, closeApproved = false, migration = null;
let rendererReady = false;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Stillwater could not start', `${error.message}\n\nYour existing diary files have not been deleted.`);
    app.quit();
  });
}

function isAppURL(value) {
  try { const u = new URL(value); return u.protocol === 'stillwater:' && u.hostname === 'app' && !u.port && !u.username && !u.password; }
  catch { return false; }
}
function trustedSender(event) {
  return mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && isAppURL(event.senderFrame.url);
}
function requireSender(event) { if (!trustedSender(event)) throw new Error('This action is only available from your diary.'); }
function safeFilename(name) { return path.basename(String(name || 'Stillwater export')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0,150) || 'Stillwater export'; }
function externalLink(url) {
  try { const u = new URL(url); if (['https:', 'http:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.href).catch(() => {}); } catch {}
}
function sendAction(action) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diary:menu-action', action); }

async function start() {
  debug('App ready');
  const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  const legacyCandidates = [
    process.env.STILLWATER_LEGACY_DIR && path.join(process.env.STILLWATER_LEGACY_DIR, 'diary.sqlite'),
    path.join(projectDirectory, 'data', 'diary.sqlite'),
    path.join(executableDirectory, 'data', 'diary.sqlite'),
    path.join(executableDirectory, '..', 'data', 'diary.sqlite'),
    path.join(executableDirectory, 'Stillwater', 'data', 'diary.sqlite')
  ].filter(Boolean);
  migration = process.env.STILLWATER_USER_DATA && !process.env.STILLWATER_LEGACY_DIR
    ? { migrated: false, reason: 'isolated-test-profile' }
    : await migrateLegacyDiary(legacyCandidates, dataDirectory);
  process.env.STILLWATER_DESKTOP = '1';
  process.env.DIARY_DATA_DIR = dataDirectory;
  backend = await import(pathToFileURL(path.join(projectDirectory, 'server.mjs')).href);
  debug('Database ready');
  protocol.handle('stillwater', async request => {
    debug(`Request ${new URL(request.url).pathname}`);
    const response = await backend.handleDesktopRequest(request);
    debug(`Response ${response.status}`);
    return response;
  });
  debug('Protocol ready');
  configurePermissions();
  debug('Permissions ready');
  configureIPC();
  configureMenu();
  debug('Menu ready');
  createWindow();
  debug('Window created');
}

function configurePermissions() {
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    contents === mainWindow?.webContents && isAppURL(requestingOrigin) && permission === 'media' && details?.mediaType === 'audio');
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const allowed = contents === mainWindow?.webContents && isAppURL(contents.getURL()) && permission === 'media'
      && details?.mediaTypes?.length > 0 && details.mediaTypes.every(t => t === 'audio');
    if (!allowed) return callback(false);
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: 'Record a voice note?',
      message: 'Allow Stillwater to use your microphone for this recording?',
      detail: 'The recording is saved in your local diary.',
      buttons: ['Allow microphone', 'Cancel'], defaultId: 1, cancelId: 1
    });
    callback(choice.response === 0);
  });
  session.defaultSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save from Stillwater', defaultPath: path.join(app.getPath('downloads'), safeFilename(item.getFilename())) });
  });
}

function configureIPC() {
  ipcMain.handle('diary:info', event => {
    requireSender(event);
    rendererReady = true;
    return { version: app.getVersion(), dataDirectory, migrated: !!migration?.migrated };
  });
  ipcMain.handle('diary:save-file', async (event, input) => {
    requireSender(event);
    if (!input || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 256 * 1024 * 1024) throw new Error('This export is too large.');
    const name = safeFilename(input.name);
    const extension = path.extname(name).slice(1).toLowerCase();
    const filters = /^[a-z0-9]{1,10}$/.test(extension)
      ? [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }];
    const selected = await dialog.showSaveDialog(mainWindow, { title: 'Save from Stillwater', defaultPath: path.join(app.getPath('documents'), name), filters });
    if (selected.canceled || !selected.filePath) return { saved: false };
    await fs.promises.writeFile(selected.filePath, input.bytes);
    return { saved: true };
  });
  ipcMain.handle('diary:print', async (event, input) => {
    requireSender(event);
    const choice = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Keep a copy of this entry', message: 'Save a PDF or print your entry?', buttons: ['Save as PDF', 'Print', 'Cancel'], defaultId: 0, cancelId: 2 });
    if (choice.response === 2) return { saved: false };
    if (choice.response === 1) {
      return new Promise(resolve => mainWindow.webContents.print({ printBackground: true }, success => resolve({ saved: success })));
    }
    const selected = await dialog.showSaveDialog(mainWindow, { title: 'Save entry as PDF', defaultPath: path.join(app.getPath('documents'), safeFilename(input?.name || 'Diary entry') + '.pdf'), filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
    if (selected.canceled || !selected.filePath) return { saved: false };
    const pdf = await mainWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true });
    await fs.promises.writeFile(selected.filePath, pdf);
    return { saved: true };
  });
  ipcMain.on('diary:close-ready', async (event, token, result) => {
    if (!trustedSender(event) || token !== closeToken) return;
    clearTimeout(closeTimer); closeToken = null;
    if (result?.ok === true) { closeApproved = true; mainWindow.close(); }
    else await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Your diary is still open', message: String(result?.message || 'Please finish saving your entry before closing.'), buttons: ['Keep writing'] });
  });
}

function configureMenu() {
  const template = [
    { label: 'Diary', submenu: [
      { label: 'New entry', accelerator: 'CmdOrCtrl+J', click: () => sendAction('new') },
      { label: 'Save now', accelerator: 'CmdOrCtrl+S', click: () => sendAction('save') },
      { type: 'separator' },
      { label: 'Backup diary…', click: () => sendAction('backup') },
      { label: 'Import backup or text…', click: () => sendAction('import') },
      { label: 'Open diary data folder', click: () => shell.openPath(dataDirectory) },
      { type: 'separator' },
      { label: 'Exit', accelerator: 'Alt+F4', click: () => mainWindow?.close() }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Find a memory', accelerator: 'CmdOrCtrl+K', click: () => sendAction('search') }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { label: 'Help', submenu: [{ label: 'About Stillwater', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: 'Stillwater', message: `Stillwater ${app.getVersion()}`, detail: 'A quiet place for your days.\n\nYour diary is stored on this computer. No account, cloud service, or local web server is required.\n\nPassword protection and encryption at rest are not included yet.' }) }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Stillwater', width: 1280, height: 900, minWidth: 720, minHeight: 600,
    backgroundColor: '#fff6fa', icon: path.join(projectDirectory, 'build', 'icon.png'),
    show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: true }
  });
  mainWindow.webContents.setWindowOpenHandler(details => { externalLink(details.url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppURL(url) || !['/', '/index.html'].includes(new URL(url).pathname)) { event.preventDefault(); externalLink(url); }
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.on('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-finish-load', () => debug('Page loaded'));
  mainWindow.webContents.on('render-process-gone', (_event, details) => debug(`Renderer stopped: ${details.reason}`));
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) dialog.showErrorBox('Stillwater could not open', `${description}\n\nReopen the app to try again.`);
  });
  mainWindow.on('close', event => {
    if (closeApproved) return;
    event.preventDefault();
    if (closeToken) return;
    if (!rendererReady || mainWindow.webContents.isCrashed()) {
      dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Close Stillwater?', message: 'The writing window is not responding. Saved entries are safe; unfinished writing can be recovered next time.', buttons: ['Keep open', 'Close app'], defaultId: 0, cancelId: 0 }).then(choice => {
        if (choice.response === 1) { closeApproved = true; mainWindow.destroy(); }
      });
      return;
    }
    closeToken = randomUUID();
    mainWindow.webContents.send('diary:prepare-close', closeToken);
    closeTimer = setTimeout(() => {
      closeToken = null;
      dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Still saving', message: 'Stillwater has kept the window open while your last changes finish saving. Try closing again in a moment.', buttons: ['Keep open'] });
    }, 20000);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(APP_URL);
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { clearTimeout(closeTimer); backend?.closeDatabase(); });
