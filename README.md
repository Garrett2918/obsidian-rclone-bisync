# Rclone Bisync

Sync an Obsidian vault with Google Drive for free. This desktop plugin runs
`rclone bisync` for you, so edits, new files and deletions move in both
directions. Each vault lands in `Obsidian/<vault name>/` on your Drive. Any
other rclone remote works too.

## Setup

1. Install rclone: `winget install Rclone.Rclone`
2. Connect Google Drive. Open a new terminal and run `rclone config`:
   `n` (new remote) → name **gdrive** → storage **drive** → leave client_id
   and client_secret blank → scope **1** (full access) → accept the defaults
   → **y** for auto config. Sign in to Google in the browser window rclone opens.
3. Copy the `rclone-bisync` folder into `<your vault>\.obsidian\plugins\`.
   Repeat for each vault you want to sync.
4. In Obsidian, open **Settings → Community plugins**, turn off Restricted
   mode if it's on, and enable **Rclone Bisync**.
5. In the plugin settings, click **Test connection**, then **Dry run**, then **Sync**.

## How it works

**When it syncs.** At startup, every 5 minutes, and 30 seconds after you stop
editing. You can change all three. To sync by hand, click the ribbon icon, the
☁ item in the status bar, or run **Sync now** from the command palette.

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

## Troubleshooting

- To see what happened, run **Rclone Bisync: Open sync log**.
- If syncs keep failing, run **Rclone Bisync: Force full resync**.
- If you see "rclone not found", enter the full path to `rclone.exe` in the plugin settings.
- Closing Obsidian doesn't trigger a final sync. Edits you make right before
  closing go up the next time you open it.

Desktop only. Obsidian mobile can't run rclone.
