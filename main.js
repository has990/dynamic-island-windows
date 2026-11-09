const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

// Overlay windows on Windows can blank out for a moment when another app (Chrome/YouTube) starts playing,
// because Chromium wrongly decides the island is hidden/occluded and stops painting it. Turn that off.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const W = 480, H = 300;
const CMD = path.join(os.tmpdir(), 'dynamic-island.cmd');
const log = s => { try { fs.appendFileSync(path.join(os.tmpdir(), 'dynamic-island.log'), new Date().toISOString() + ' ' + s + '\n'); } catch {} };
process.on('uncaughtException', e => log('main error: ' + (e && e.stack || e)));
const PSEXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let win, ps, lastTitle = '', quitting = false, lastSent = '', lastArt = '', artCache = { k: '', art: '' };

if (!app.requestSingleInstanceLock()) app.exit(0);      // another copy is already running: leave quietly
app.on('second-instance', () => { if (win && !win.isDestroyed()) win.reload(); });   // launching again refreshes the running island

// One long-running PowerShell process: reads media + volume, takes commands via a small file
function startMedia() {
  const script = path.join(os.tmpdir(), 'dynamic-island.ps1');
  fs.writeFileSync(script, '\ufeff' + fs.readFileSync(path.join(__dirname, 'media.ps1'), 'utf8'));
  ps = spawn(PSEXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CmdFile', CMD], { windowsHide: true });
  let buf = '';
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); }
  });
  ps.on('error', e => handle(JSON.stringify({ err: 'cannot start PowerShell: ' + e.message })));
  ps.stderr.setEncoding('utf8');
  ps.stderr.on('data', d => handle(JSON.stringify({ err: 'script: ' + d.trim().slice(0, 300) })));
  ps.on('exit', code => { if (!quitting) { handle(JSON.stringify({ err: 'helper stopped (' + code + ')' })); setTimeout(startMedia, 3000); } });
}

// YouTube sends huge cover images; shrink once here so the island never has to decode them
function shrink(dataUrl) {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return dataUrl;
    const small = img.getSize().width > 240 ? img.resize({ width: 240, quality: 'good' }) : img;
    return 'data:image/jpeg;base64,' + small.toJPEG(82).toString('base64');
  } catch { return dataUrl; }
}

function emit(m) {
  const str = JSON.stringify(m);
  if (str !== lastSent && win && !win.isDestroyed()) { lastSent = str; win.webContents.send('media', m); }
}

function handle(line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.err) log(m.err);
  if (m.title && m.title !== lastTitle && win && !win.isDestroyed()) { lastTitle = m.title; log('track: ' + m.title + ' | visible=' + win.isVisible() + ' bounds=' + JSON.stringify(win.getBounds())); }
  let rawArt = null;                   // null = cover unchanged, '' = no cover, otherwise the new cover
  if (m.title) {                       // album art only arrives once per track; cache it
    const k = m.title + '|' + m.artist;
    if (m.art) artCache = { k, art: m.art };
    const art = artCache.k === k ? artCache.art : '';
    if (art !== lastArt) { rawArt = art; lastArt = art; }
  }
  delete m.art;
  if (rawArt === null) return emit(m);
  m.art = '';
  emit(m);                             // 1) title/artist/progress go out immediately
  if (rawArt) setImmediate(() => emit({ ...m, art: shrink(rawArt) }));   // 2) cover follows once it has been shrunk
}

app.whenReady().then(() => {
  // start with Windows on first run only (the settings panel can turn it off later)
  const flag = path.join(app.getPath('userData'), 'first-run');
  if (app.isPackaged && !fs.existsSync(flag)) {
    app.setLoginItemSettings({ openAtLogin: true });
    try { fs.mkdirSync(path.dirname(flag), { recursive: true }); fs.writeFileSync(flag, '1'); } catch {}
  }
  const { width } = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    width: W, height: H, x: Math.round((width - W) / 2), y: 0,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false }
  });
  // lets the island listen to system audio (for music-reactive eyes); nothing is recorded or saved
  try {
    session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then(src => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
    });
  } catch (e) { log('audio capture unavailable: ' + e.message); }
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  win.webContents.on('render-process-gone', (_, d) => { log('window crashed: ' + d.reason); try { win.reload(); } catch {} });
  win.webContents.on('console-message', (_e, level, message, line) => { if (level >= 2) log('page error: ' + message + ' (line ' + line + ')'); });
  startMedia();
  // keep the island above everything, without re-stacking the window every 2s (that fought with Chrome/YouTube starting playback)
  ['hide', 'minimize'].forEach(ev => win.on(ev, () => { log('window event: ' + ev); try { if (win.isMinimized()) win.restore(); win.showInactive(); } catch {} }));
  win.on('unresponsive', () => log('window unresponsive'));
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) { log('watchdog: window was not visible, restoring'); win.showInactive(); }
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 1000);

  let lx = null, ly = null;           // cursor tracking, works over any app
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (p.x === lx && p.y === ly) return;
    lx = p.x; ly = p.y;
    const b = win.getBounds();
    win.webContents.send('cursor', { x: p.x - (b.x + b.width / 2), y: p.y - (b.y + 18) });
  }, 33);
});

ipcMain.on('hover', (_, on) => win.setIgnoreMouseEvents(!on, { forward: true }));
ipcMain.on('control', (_, a) => { if (/^(play|next|prev|vol (0(\.\d+)?|1(\.0+)?)|seek \d+(\.\d+)?)$/.test(a)) fs.writeFileSync(CMD, a); });
ipcMain.on('quit', () => app.quit());
ipcMain.on('startAudio', () => {
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.__startAudio && window.__startAudio()', true).catch(() => {});
});
ipcMain.handle('getLogin', () => app.getLoginItemSettings().openAtLogin);
ipcMain.on('setLogin', (_, on) => { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on }); });
app.on('before-quit', () => { quitting = true; if (ps) ps.kill(); });
app.on('window-all-closed', () => app.quit());
