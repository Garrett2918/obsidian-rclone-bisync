'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, FileSystemAdapter } = require('obsidian');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  rclonePath: 'rclone',
  remote: 'gdrive',
  remoteFolder: 'Obsidian',
  remoteCheckMinutes: 0,    // 0 = only sync on startup, after edits, or by hand
  syncOnStartup: true,
  syncAfterEditSeconds: 30,
  extraExcludes: '',
  // Per-device state. data.json is excluded from the sync, so these never travel.
  resyncHash: '',
  lastSync: 0,
};

const MAX_LOG_BYTES = 1024 * 1024;

// The Flatpak build of Obsidian runs in a sandbox with its own /usr, so it
// can't see an rclone installed on the system.
const IN_FLATPAK = process.platform === 'linux' && fs.existsSync('/.flatpak-info');
const FLATPAK_HINT = 'Obsidian is running as a Flatpak and can\'t see your system\'s rclone. '
  + 'Either run "flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian" '
  + 'and restart Obsidian, or put the rclone binary from rclone.org/downloads in ~/.local/bin.';

module.exports = class RcloneBisyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice('Rclone Bisync only works on desktop vaults.');
      return;
    }

    this.syncing = false;
    this.pending = false;
    this.failed = false;
    this.dirty = false;       // local files changed since the last sync started
    this.intervalId = null;
    this.editTimer = null;

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable');
    this.statusEl.setAttribute('aria-label', 'Sync now');
    this.statusEl.onClickEvent(() => this.sync({ manual: true }));
    this.refreshStatus();

    this.addRibbonIcon('refresh-cw', 'Sync with rclone now', () => this.sync({ manual: true }));

    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.sync({ manual: true }) });
    this.addCommand({ id: 'dry-run', name: 'Preview sync (dry run, writes to log)', callback: () => this.sync({ manual: true, dryRun: true }) });
    this.addCommand({ id: 'resync', name: 'Force full resync', callback: () => this.sync({ manual: true, resync: true }) });
    this.addCommand({ id: 'open-log', name: 'Open sync log', callback: () => this.openLog() });

    this.addSettingTab(new RcloneBisyncSettingTab(this.app, this));

    for (const ev of ['modify', 'create', 'delete', 'rename']) {
      this.registerEvent(this.app.vault.on(ev, () => this.onVaultChange()));
    }
    this.registerInterval(window.setInterval(() => this.refreshStatus(), 30 * 1000));
    this.registerInterval(window.setInterval(() => this.syncIfDirty(), 5 * 60 * 1000));
    this.scheduleInterval();

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.syncOnStartup) this.sync();
    });
  }

  onunload() {
    if (this.intervalId) window.clearInterval(this.intervalId);
    if (this.editTimer) window.clearTimeout(this.editTimer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    delete this.settings.intervalMinutes; // replaced by remoteCheckMinutes in 1.1.0
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- paths -----------------------------------------------------------------

  vaultPath() {
    return this.app.vault.adapter.getBasePath();
  }

  pluginPath(file) {
    return path.join(this.vaultPath(), this.manifest.dir, file);
  }

  remotePath() {
    const folder = this.settings.remoteFolder.replace(/^\/+|\/+$/g, '');
    const name = this.app.vault.getName();
    return `${this.settings.remote}:${folder ? folder + '/' : ''}${name}`;
  }

  rcloneBin() {
    // Paths pasted from `which`/`where` may carry quotes or a leading ~.
    let p = this.settings.rclonePath.trim().replace(/^(["'])(.*)\1$/, '$2') || 'rclone';
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (p !== 'rclone') return p;
    // Obsidian's PATH is often incomplete: on Windows it misses installs made
    // after launch, and macOS/Linux apps opened from the Dock or a launcher
    // don't see PATH changes made in shell profiles. Check the usual install
    // locations, then ask the login shell, before falling back to PATH.
    for (const candidate of rcloneCandidates()) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return (!IN_FLATPAK && loginShellRclone()) || p;
  }

  // The program and leading arguments that start rclone. In a Flatpak that may
  // talk to the host, rclone runs outside the sandbox through flatpak-spawn,
  // with the system's PATH, config and cache.
  rcloneCommand() {
    if (IN_FLATPAK && flatpakHostAccess()) {
      const p = this.settings.rclonePath.trim().replace(/^(["'])(.*)\1$/, '$2') || 'rclone';
      return ['flatpak-spawn', ['--host', p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p]];
    }
    return [this.rcloneBin(), []];
  }

  buildFilters() {
    const c = this.app.vault.configDir;
    const p = this.manifest.dir;
    const lines = [
      '# Generated by the Rclone Bisync plugin. Add excludes in its settings instead.',
      // This plugin's per-device state and log
      `- /${p}/data.json`,
      `- /${p}/sync.log`,
      `- /${p}/filters.txt`,
      `- /${p}/filters.txt.md5`,
      // Per-device UI state (open tabs, pane layout), changes constantly
      `- /${c}/workspace.json`,
      `- /${c}/workspace-mobile.json`,
      `- /${c}/workspaces.json`,
      // Version control and OS/editor junk
      '- .git/**',
      '- .DS_Store',
      '- Thumbs.db',
      '- desktop.ini',
      '- ~$*',
      '- *.tmp',
    ];
    for (const raw of this.settings.extraExcludes.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      lines.push(/^[-+] /.test(line) ? line : `- ${line}`);
    }
    return lines.join('\n') + '\n';
  }

  // ---- triggers --------------------------------------------------------------

  // Optional timed sync that pulls changes made on other devices. Off by default:
  // without it, the plugin only syncs at startup, after local edits, or by hand.
  scheduleInterval() {
    if (this.intervalId) window.clearInterval(this.intervalId);
    this.intervalId = null;
    const minutes = Number(this.settings.remoteCheckMinutes);
    if (minutes > 0) {
      this.intervalId = window.setInterval(() => this.sync(), minutes * 60 * 1000);
    }
  }

  onVaultChange() {
    if (!this.app.workspace.layoutReady) return;
    this.dirty = true;
    const seconds = Number(this.settings.syncAfterEditSeconds);
    if (!(seconds > 0)) return;
    if (this.editTimer) window.clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => this.sync(), seconds * 1000);
  }

  // Picks up local edits the edit timer didn't sync: a failed sync, or the
  // edit timer turned off. Does nothing when no files changed.
  syncIfDirty() {
    if (this.dirty && !this.syncing) this.sync();
  }

  // ---- sync ------------------------------------------------------------------

  run(args) {
    return new Promise((resolve) => {
      let out = '';
      let child;
      const [cmd, pre] = this.rcloneCommand();
      const host = cmd === 'flatpak-spawn';
      try {
        child = spawn(cmd, [...pre, ...args], { windowsHide: true, env: rcloneEnv(host) });
      } catch (e) {
        resolve({ code: -1, out: String(e) });
        return;
      }
      const grab = (d) => { out = (out + d.toString()).slice(-8000); };
      child.stdout.on('data', grab);
      child.stderr.on('data', grab);
      child.on('error', (e) => resolve({
        code: -1,
        out: e.code === 'ENOENT' ? notFoundMessage() : String(e),
      }));
      child.on('close', (code) => {
        // flatpak-spawn reports a missing host command itself.
        if (host && code !== 0 && /Failed to start command|No such file or directory/.test(out)) {
          resolve({ code: -1, out: 'rclone not found on the host. Install it (rclone.org/install), or set its full path in the plugin settings.' });
        } else {
          resolve({ code, out });
        }
      });
    });
  }

  async sync({ manual = false, dryRun = false, resync = false } = {}) {
    if (this.syncing) {
      if (!dryRun) this.pending = true;
      if (manual) new Notice('Sync already running; another will follow.');
      return;
    }
    if (this.editTimer) window.clearTimeout(this.editTimer);
    this.syncing = true;
    if (!dryRun) this.dirty = false;
    this.refreshStatus();

    try {
      const filters = this.buildFilters();
      const dest = this.remotePath();
      fs.writeFileSync(this.pluginPath('filters.txt'), filters);

      const logFile = this.pluginPath('sync.log');
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) fs.writeFileSync(logFile, '');

      // bisync must be resynced after its filters or paths change, and on first run.
      const hash = crypto.createHash('sha256').update(dest + '\n' + filters).digest('hex');
      const needResync = resync || this.settings.resyncHash !== hash;

      if (needResync && !dryRun) {
        const mk = await this.run(['mkdir', dest, '--log-file', logFile]);
        if (mk.code !== 0) throw new Error(mk.out.trim() || `rclone mkdir failed (exit ${mk.code})`);
      }

      const args = [
        'bisync', this.vaultPath(), dest,
        '--filters-file', this.pluginPath('filters.txt'),
        '--create-empty-src-dirs',
        '--resilient', '--recover',          // survive interruptions without a manual resync
        '--conflict-resolve', 'newer',       // edited on both sides: newest wins...
        '--conflict-loser', 'num',           // ...and the other copy is kept as name.conflict1
        '--max-lock', '5m',
        '--drive-skip-gdocs',                // ignore native Google Docs/Sheets
        '--log-file', logFile, '--log-level', 'INFO',
      ];
      if (needResync) args.push('--resync', '--resync-mode', 'newer');
      if (dryRun) args.push('--dry-run');

      const { code, out } = await this.run(args);
      if (code !== 0) {
        if (code === -1) throw new Error(out);
        const tail = this.readLogTail(logFile);
        const hint = /--resync/.test(tail) ? ' Run "Rclone Bisync: Force full resync".' : ' See "Rclone Bisync: Open sync log".';
        throw new Error(`rclone exited with code ${code}.${hint}`);
      }

      this.failed = false;
      if (dryRun) {
        new Notice('Dry run finished. Open the sync log to see what would change.');
      } else {
        if (needResync) this.settings.resyncHash = hash;
        this.settings.lastSync = Date.now();
        await this.saveSettings();
        if (manual) new Notice('Sync complete.');
      }
    } catch (e) {
      this.failed = true;
      if (!dryRun) this.dirty = true;
      console.error('[rclone-bisync]', e);
      new Notice(`Sync failed: ${e.message}`, 10000);
    } finally {
      this.syncing = false;
      this.refreshStatus();
      if (this.pending) {
        this.pending = false;
        this.sync();
      }
    }
  }

  readLogTail(file) {
    try {
      const size = fs.statSync(file).size;
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      return buf.toString();
    } catch (e) {
      return '';
    }
  }

  openLog() {
    const file = this.pluginPath('sync.log');
    if (!fs.existsSync(file)) {
      new Notice('No sync log yet.');
      return;
    }
    require('electron').shell.openPath(file);
  }

  refreshStatus() {
    if (!this.statusEl) return;
    let text;
    if (this.syncing) text = 'Syncing\u2026';
    else if (this.failed) text = 'Sync failed';
    else if (this.settings.lastSync) text = `Synced ${timeAgo(this.settings.lastSync)}`;
    else text = 'Not synced yet';
    // Escaped so the file stays plain ASCII and can't be mangled by editors.
    this.statusEl.setText(`\u2601 ${text}`);
  }
};

function rcloneCandidates() {
  const home = os.homedir();
  const env = process.env;
  if (process.platform === 'win32') {
    return [
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'rclone.exe'),
      path.join(home, 'scoop', 'shims', 'rclone.exe'),
      path.join(env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'rclone.exe'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'rclone', 'rclone.exe'),
    ];
  }
  return [
    '/opt/homebrew/bin/rclone',   // Homebrew, Apple Silicon
    '/usr/local/bin/rclone',      // Homebrew (Intel), rclone install script
    '/opt/local/bin/rclone',      // MacPorts
    '/usr/bin/rclone',            // Linux distro packages
    '/snap/bin/rclone',
    '/home/linuxbrew/.linuxbrew/bin/rclone',
    path.join(home, '.nix-profile', 'bin', 'rclone'),
    '/run/current-system/sw/bin/rclone', // NixOS
    path.join(home, '.local', 'bin', 'rclone'),
    path.join(home, 'bin', 'rclone'),
    path.join(home, 'go', 'bin', 'rclone'), // go install
  ];
}

function notFoundMessage() {
  if (IN_FLATPAK) return `rclone not found. ${FLATPAK_HINT}`;
  return 'rclone not found. Install it (rclone.org/install), or set its full path in the plugin settings.';
}

// Whether the Flatpak sandbox may run commands on the host (flatpak-spawn --host).
function flatpakHostAccess() {
  try {
    return /^org\.freedesktop\.Flatpak=(talk|own)\s*$/m.test(fs.readFileSync('/.flatpak-info', 'utf8'));
  } catch (e) {
    return false;
  }
}

// Inside the sandbox, XDG_CONFIG_HOME points into ~/.var/app, so an rclone
// run there would miss the config made by `rclone config` on the system.
function rcloneEnv(host) {
  const env = Object.assign({}, process.env);
  if (IN_FLATPAK && !host && !env.RCLONE_CONFIG) {
    const conf = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
    if (fs.existsSync(conf)) env.RCLONE_CONFIG = conf;
  }
  return env;
}

// macOS and Linux only: look rclone up through the user's login shell, which
// loads the PATH set in ~/.zprofile, ~/.bash_profile and similar. Only a
// successful lookup is cached, so installing rclone later still gets found.
let shellRclone = null;
function loginShellRclone() {
  if (process.platform === 'win32') return null;
  if (shellRclone) return shellRclone;
  try {
    const shell = process.env.SHELL || '/bin/sh';
    const out = execFileSync(shell, ['-lc', 'command -v rclone'], { encoding: 'utf8', timeout: 5000 });
    // Profiles can print banners; the path is the last line.
    const found = out.trim().split('\n').pop().trim();
    if (path.isAbsolute(found) && fs.existsSync(found)) shellRclone = found;
  } catch (e) {
    // Not installed, or the shell failed; fall back to PATH.
  }
  return shellRclone;
}

function timeAgo(ms) {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

class RcloneBisyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl)
      .setName('rclone executable')
      .setDesc('Leave as "rclone" to find it automatically, or enter the full path to the rclone binary.')
      .addText((t) => t.setValue(s.rclonePath).onChange(async (v) => { s.rclonePath = v; await save(); }));

    new Setting(containerEl)
      .setName('Remote name')
      .setDesc('The name you gave the remote in `rclone config`.')
      .addText((t) => t.setValue(s.remote).onChange(async (v) => { s.remote = v.trim().replace(/:$/, ''); await save(); }));

    new Setting(containerEl)
      .setName('Remote folder')
      .setDesc('Folder in the remote that holds your vaults. This vault syncs to <folder>/<vault name>.')
      .addText((t) => t.setValue(s.remoteFolder).onChange(async (v) => { s.remoteFolder = v; await save(); }));

    new Setting(containerEl)
      .setName('Syncs to')
      .setDesc(this.plugin.remotePath())
      .addButton((b) => b.setButtonText('Test connection').onClick(async () => {
        const { code, out } = await this.plugin.run(['lsd', `${s.remote}:`, '--max-depth', '1']);
        new Notice(code === 0 ? `Connected to ${s.remote}.` : `Connection failed: ${out.trim().slice(-300)}`, 8000);
      }));

    new Setting(containerEl)
      .setName('Check Drive for changes (minutes)')
      .setDesc('Sync on a timer to pull in edits from your other devices, even when nothing changed here. 0 turns it off.')
      .addText((t) => t.setValue(String(s.remoteCheckMinutes)).onChange(async (v) => {
        s.remoteCheckMinutes = Math.max(0, Number(v) || 0);
        await save();
        this.plugin.scheduleInterval();
      }));

    new Setting(containerEl)
      .setName('Sync after edits (seconds)')
      .setDesc('Sync this long after you stop changing files. 0 turns it off.')
      .addText((t) => t.setValue(String(s.syncAfterEditSeconds)).onChange(async (v) => {
        s.syncAfterEditSeconds = Math.max(0, Number(v) || 0);
        await save();
      }));

    new Setting(containerEl)
      .setName('Sync on startup')
      .addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => { s.syncOnStartup = v; await save(); }));

    new Setting(containerEl)
      .setName('Extra excludes')
      .setDesc('One rclone pattern per line, e.g. "Attachments/**" or "*.pdf". Changing this triggers a full resync.')
      .addTextArea((t) => {
        t.setValue(s.extraExcludes).onChange(async (v) => { s.extraExcludes = v; await save(); });
        t.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc(s.lastSync ? `Last synced ${new Date(s.lastSync).toLocaleString()}` : 'Never synced on this device.')
      .addButton((b) => b.setButtonText('Dry run').onClick(() => this.plugin.sync({ manual: true, dryRun: true })))
      .addButton((b) => b.setCta().setButtonText('Sync').onClick(() => this.plugin.sync({ manual: true })));
  }
}
