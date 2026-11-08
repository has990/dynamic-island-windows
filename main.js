const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const W = 480, H = 240;
const CMD = path.join(os.tmpdir(), 'dynamic-island.cmd');
const PSEXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let win, ps, quitting = false, lastSent = '', artCache = { k: '', art: '' };

if (!app.requestSingleInstanceLock()) app.quit();

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

function handle(line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.err) try { fs.appendFileSync(path.join(os.tmpdir(), 'dynamic-island.log'), new Date().toISOString() + ' ' + m.err + '\n'); } catch {}
  if (m.title) {                       // album art only arrives once per track; cache it
    const k = m.title + '|' + m.artist;
    if (m.art) artCache = { k, art: m.art };
    m.art = artCache.k === k ? artCache.art : '';
  }
  const s = JSON.stringify(m);
  if (s !== lastSent && win && !win.isDestroyed()) { lastSent = s; win.webContents.send('media', m); }
}

app.whenReady().then(() => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });   // start with Windows
  const { width } = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    width: W, height: H, x: Math.round((width - W) / 2), y: 0,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  startMedia();

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
ipcMain.on('control', (_, a) => { if (/^(play|next|prev|vol (0(\.\d+)?|1(\.0+)?))$/.test(a)) fs.writeFileSync(CMD, a); });
ipcMain.on('quit', () => app.quit());
app.on('before-quit', () => { quitting = true; if (ps) ps.kill(); });
app.on('window-all-closed', () => app.quit());
