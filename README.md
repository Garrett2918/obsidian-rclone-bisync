# Rclone Bisync

Sync an Obsidian vault with Google Drive for free. This desktop plugin runs
`rclone bisync` for you, so edits, new files and deletions move in both
directions. Each vault lands in `Obsidian/<vault name>/` on your Drive. Any
other rclone remote works too.

## Setup

1. Install rclone (v1.66 or newer):

   | System  | Command |
   |---------|---------|
   | Windows | `winget install Rclone.Rclone` |
   | macOS   | `brew install rclone` |
   | Linux   | `sudo -v ; curl https://rclone.org/install.sh \| sudo bash` |

   Distro packages often ship an rclone too old for bisync, so on Linux use
   the install script. [rclone.org/install](https://rclone.org/install/)
   lists other options.
2. Connect Google Drive. Open a new terminal and run `rclone config`:
   `n` (new remote) → name **gdrive** → storage **drive** → leave client_id
   and client_secret blank → scope **1** (full access) → accept the defaults
   → **y** for auto config. Sign in to Google in the browser window rclone opens.
3. Copy the `rclone-bisync` folder into `<your vault>/.obsidian/plugins/`.
   Repeat for each vault you want to sync.
   On macOS, `.obsidian` is hidden in Finder. Press Cmd+Shift+. to show it.
4. In Obsidian, open **Settings → Community plugins**, turn off Restricted
   mode if it's on, and enable **Rclone Bisync**.
5. In the plugin settings, click **Test connection**, then **Dry run**, then **Sync**.

## How it works

**When it syncs.** At startup and 30 seconds after you stop editing. If you
haven't changed anything, it stays idle. To sync by hand, click the ribbon
icon, the ☁ item in the status bar, or run **Sync now** from the command palette.

If you edit the vault on another computer while this one has Obsidian open,
set **Check Drive for changes** to pull those edits on a timer (15 minutes
works well). It ships turned off.

**First sync.** On each computer, the first run merges your vault with Drive
and deletes nothing. Later runs pass deletions through.

**Conflicts.** If you edit the same note on two computers between syncs, the
newer version wins. The plugin keeps the other one as `note.md.conflict1` so
you can merge them yourself.

**Skipped files.** `.obsidian/workspace*.json` (each computer's open tabs and
layout), the plugin's own `data.json` and log, `.git`, and OS junk like
`Thumbs.db`. Add your own patterns under **Extra excludes**. Your settings,
themes and other plugins still sync.

**Safety.** rclone stops the run if it would delete more than half your files.

## Using other services

The plugin works with any storage rclone supports. Run `rclone config`,
create a remote for your service, and enter its name under **Remote name**
in the plugin settings. OneDrive, Dropbox, Box, pCloud, Nextcloud (WebDAV)
and S3-compatible storage like Backblaze B2 all work well.

**Proton Drive.** Create a remote of type `protondrive`. rclone asks for your
username, password and a 2FA code, then saves a login session so you don't
need a new code for each sync. Know these trade-offs first:

- Proton has no public API. rclone's Proton backend is in beta and copies how
  Proton's own apps talk to its servers, so a change on Proton's side can break
  syncing until rclone catches up.
- Your computer encrypts every file before upload, so syncs run slower than
  with Google Drive.
- If Proton ends your session (after a password change, for example), the
  status bar shows **Sync failed**. Run `rclone config reconnect <remote>:`
  to sign in again.
- On Windows and macOS, Proton's official Proton Drive app can sync a vault
  folder without this plugin. The plugin makes the most sense on Linux, where
  Proton has no official app.

## Troubleshooting

- To see what happened, run **Rclone Bisync: Open sync log**.
- If syncs keep failing, run **Rclone Bisync: Force full resync**.
- If you see "rclone not found", run `which rclone` (macOS/Linux) or
  `where rclone` (Windows) and paste the result into the plugin settings.
  The plugin checks the usual install folders for winget, Scoop, Chocolatey,
  Homebrew, snap and the rclone script on its own.
- The Flatpak build of Obsidian runs in a sandbox and can't start rclone.
  On Linux, use the AppImage or .deb build instead.
- Closing Obsidian doesn't trigger a final sync. Edits you make right before
  closing go up the next time you open it.

Works on Windows, macOS and Linux. Obsidian mobile can't run rclone.
