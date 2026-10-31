# ClipShelf

A native GNOME Shell clipboard history extension for Ubuntu 24.04 / GNOME 46. A small clipboard icon in the right side of the panel opens a searchable history of text, links, images and copied files. Select an entry to put its payload back on the clipboard, then paste normally in another application.

[Dark preview](docs/preview-dark.png) · [Light preview](docs/preview-light.png) · [Verification notes](docs/VERIFICATION.md)

## Install

Run these commands from this source directory in your regular desktop account:

```bash
./scripts/check-environment.sh
./scripts/install.sh
```

The installer compiles the native clipboard bridge and GSettings schema, copies only extension files into `${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/clipshelf@local.davit`, and enables the extension for your GNOME login. No autostart process is needed. Installation is repeatable.

If GNOME has not discovered the new extension, **log out and back in**. Updating a version already loaded by GNOME also requires a new login to reliably load the new JavaScript. The installer never logs you out or restarts your desktop. If user extensions are globally disabled, enable them in the Extensions application.

Runtime dependencies are GNOME Shell 46, GJS, GTK 4 and libadwaita, all present on the inspected Ubuntu desktop. Building the small native bridge additionally requires a C compiler, pkg-config, GObject Introspection tooling, and the Mutter 14 development package. On Ubuntu 24.04:

```bash
sudo apt install build-essential pkg-config libmutter-14-dev libgirepository1.0-dev
```

If sudo is unavailable and a C compiler is already present, build with an extracted
Ubuntu 24.04 amd64 SDK instead. This downloads headers/tooling without installing
system packages:

```bash
./scripts/bootstrap-sdk.sh
CLIPSHELF_SDK_DIR="$PWD/build/sdk/root" ./scripts/install.sh
```

When the SDK exists at `build/sdk/root`, the build script uses it automatically if
system development packages are missing. Subsequent `./scripts/install.sh` runs
therefore need no administrator password.

See [native/README.md](native/README.md) for the GNOME 46 bridge design and build details.

Open preferences with the popup's settings button or:

```bash
gnome-extensions prefs clipshelf@local.davit
```

To install files without changing desktop activation, use `./scripts/install.sh --no-enable`.

## Use

- Click the panel clipboard icon, or press **Super+Shift+V**.
- Search, select All / Text / Images / Files / Pinned, and scroll through recent entries.
- Select an item, or use the arrow keys and Enter, to restore it and close the popup. Escape and clicking outside close the popup.
- Pin entries to keep them through ordinary cleanup. Delete individual entries with their small delete buttons.
- Pause recording from the popup or preferences. Existing history remains usable.
- Clear history asks for confirmation and preserves pinned entries.

Preferences control the number of unpinned entries (default 100), maximum item payload (16 MiB), total payload storage (128 MiB), recording pause, and the keyboard shortcut. An item's size includes all retained MIME representations. Pinned entries count toward storage; new entries are refused if pinned data leaves insufficient space. Lowering a limit never silently deletes pinned items. The payload limit excludes the index, filesystem overhead, and quarantined recovery backups.

The index has safety limits of 8 MiB and 10,000 entries; a commit exceeding either
is refused without replacing saved history. Search uses the first 8,192 characters
of text metadata plus file URI references. Full clipboard payloads are retained.

## Clipboard behavior and privacy

ClipShelf monitors Mutter's **CLIPBOARD** selection, which supports GNOME Wayland and X11. It does not record the PRIMARY selection created by highlighting text with the mouse. Monitoring continues while the popup is closed.

Text, Unicode, multiline content, URLs, common image payloads, supported HTML/rich-text representations, and Nautilus file references retain their clipboard MIME data. Text aliases are normalized to UTF-8 plain text, HTML bytes retain a plain fallback; RTF bytes are retained when the provider also supplies plain text or HTML (RTF-only sources are unsupported), and images retain one preferred offered raster encoding (PNG, JPEG, WebP, GIF, BMP or TIFF). The native bridge advertises multiple representations in one selection source, rather than replacing them with repeated single-format writes. Source applications can only supply the formats they actually offer. Application-private formats, vector-image clipboard formats and unsupported MIME types are skipped.

Local files and folders are references to their original locations, not archived copies. Remote file-manager protocols such as SFTP/SMB are unsupported; ClipShelf rejects those file operations. Restoring historical file entries always publishes **copy** semantics, including entries originally captured from a cut operation. A file that has been moved or deleted is unavailable. Pasting a restored file into Nautilus copies the original file; it does not restore deleted file contents.

History stays in `${XDG_DATA_HOME:-$HOME/.local/share}/clipshelf`, with private directory/file permissions, immutable payload files, and an atomically replaced index. It is **not encrypted**. Nothing is sent over the network, and clipboard contents are not written to logs. Sensitive-content markers are respected when source applications provide them; ordinary clipboard text cannot reliably be identified as a password. Pause recording when needed.

The interface is hidden on the lock screen. Disabling the extension disconnects monitoring, removes its panel/shortcut/UI, and cancels pending work. An already restored clipboard payload can remain available through the native selection source without retaining JavaScript callbacks or a background process.

## Verification

The development machine reported Ubuntu **24.04.5**, GNOME Shell **46.0**, Mutter **46.2 / Meta 14**, GJS **1.80.2**, GTK **4.14**, and libadwaita **1.5**. Its active session reported **X11**. API checks use these installed libraries, rather than assuming newer online documentation matches.

Run the repeatable headless checks from the repository root:

```bash
./scripts/test.sh
# With an extracted SDK:
CLIPSHELF_SDK_DIR="$PWD/build/sdk/root" ./scripts/test.sh
```

The current run passed **42 clipboard/native assertions** and **32 history-storage assertions**,
covering exact multi-MIME binary streams, concurrent native reads, Unicode/multiline content,
cut-to-copy normalization, sensitive markers, pause/resume, restore-loop prevention, rapid
owner changes, deduplication, persistence, corruption recovery, pinned quotas, and missing files.
The monitor lifecycle tests use a controlled selection double; the native stream tests use
the real MetaSelectionSource subclass.

An optional isolated compositor smoke check is available as `./scripts/test-shell.sh`.
It runs a separate headless GNOME instance and does not restart the active desktop.
It passed **62 assertions**, including separate GTK Wayland provider/consumer
processes, original provider exit, exact text/HTML/image/file MIME restoration,
image decoding, keyboard navigation, filters, preferences, and simulated lock-mode
transitions. The rendered dark and light popups were inspected.
Keyboard handlers are checked deterministically by default. Optional real virtual
keyboard injection also passed in a separate run:
`CLIPSHELF_SMOKE_VIRTUAL_KEYS=1 ./scripts/test-shell.sh`. Headless input timing can
vary; physical desktop keyboard use remains in the manual checklist.
`./scripts/test-install.sh` verifies repeated installation, removal, history retention
and explicit purging under temporary directories and a private D-Bus.

Firefox, terminal and Nautilus UI pastes, real lock/unlock, and a fresh login/reboot
still require the desktop checklist below. Synthetic GTK integration checks do not
establish those application-specific and session-lifecycle results. Repeat the
clipboard checks in each session type you use.

| Check | Exact desktop steps | Expected result |
| --- | --- | --- |
| Keyboard / dismiss | Open with Super+Shift+V; type a search; press Down then Enter; paste. Reopen and press Escape; reopen and click outside. | Search receives focus, selection restores, and both dismissal methods close the popup. |
| Browser text | Copy a sentence in Firefox; open ClipShelf; select it; paste into Text Editor. | The full sentence pastes. |
| Terminal / Unicode | Run `printf 'Բարեւ աշխարհ\nsecond line\n'`; select both output lines and use Ctrl+Shift+C; restore and paste in Text Editor. | Armenian characters and line breaks are intact. Merely selecting terminal text does not add an entry. |
| URL / HTML | Copy a browser URL, then copy formatted browser text. Restore each and paste into a plain editor and, for rich text, an application that accepts HTML. | Plain text remains usable; supported formatting is retained where the destination accepts it. |
| Image | Take a screenshot to the clipboard with Print Screen; restore it from history; paste in an image-capable application such as LibreOffice Draw. | A real image pastes, and the popup shows a real thumbnail. |
| Single file | In Files, copy a disposable test file; restore it; navigate to a different folder; paste. | Nautilus creates a copy of the original file. |
| Multiple files | Copy two disposable files in Files; restore and paste them into a different folder. | Both files copy; the history row shows their count. |
| Historical cut | Cut a disposable file, restore its history entry, then paste into another folder. | A copy is made and the original remains. |
| Missing reference | Copy a disposable file, move/delete it, then reopen its history row. | The entry reports unavailable instead of pretending to archive the contents. |
| Dedup / restore | Copy the same text twice with a different item between; restore an older item. | One matching entry moves to the top; restoring causes no capture loop. |
| Rapid copy | Copy three different short strings quickly, then wait a moment and inspect history. | The current owner wins; entries are complete, with no partial payloads or restore loops. Intermediate transient owners may be skipped. |
| Pause / pin / limits | Pin an entry; pause and copy another; resume; lower history/storage limits; clear history after confirmation. | Paused copies are ignored; pinned data survives ordinary cleanup and clear. |
| Disable / enable | Run the commands below; inspect the panel and copy between steps. | No duplicate icon, watcher or shortcut after re-enabling. |
| Lock / unlock | Lock with Super+L, then unlock. | No ClipShelf interface on the lock screen; one usable panel icon after unlock. |
| Login / persistence | Save several entries; log out and back in without manually launching anything; restore and paste an entry. | The panel icon and stored history return automatically. Repeat after reboot if desired. |

```bash
gnome-extensions disable clipshelf@local.davit
gnome-extensions enable clipshelf@local.davit
```

## Troubleshooting and limits

- **No icon:** run `./scripts/check-environment.sh`. Check `gnome-extensions info clipshelf@local.davit`, global user-extension status in Extensions, and GNOME version. Log out/in after a first install or update. Only GNOME 46 is declared supported.
- **Build fails:** install the build dependencies above. The native bridge must be compiled against the installed Mutter 14 ABI. Rebuild/reinstall after changing the GNOME major version; do not bypass the shell-version check.
- **Memory use:** active payload bytes remain in GNOME Shell memory for immediate restoration. Raising the storage limit can raise RAM use; the default retained-payload cap is 128 MiB, plus current clipboard data and temporary buffers.
- **No copied item:** check Pause, the selected filter/search, item size, and available storage. Sensitive markers and unsupported clipboard formats are skipped. Clipboard ownership may disappear before a source finishes responding.
- **Cannot paste a file:** check that the original still exists and is accessible. Local file URIs are supported; network file-manager protocols and application-private drag/drop formats may not be.
- **Cannot paste formatting/image:** the destination must accept one of the original offered formats. Clipboard history is not a universal document converter. Unsupported app-private formats, huge payloads, malformed entries and nonclipboard selections are not retained.
- **History error:** use the popup's error message and inspect file permissions/free disk space. A corrupt index is quarantined as `index.corrupt-*.json`, with damaged payloads under `recovery-*`, rather than parsed as trusted history. Recovery backups are excluded from the payload quota and ordinary clear; remove them explicitly if no longer needed, or use the uninstall purge. Existing data is never printed to logs.
- **Shortcut conflict:** change or disable the accelerator in preferences. Super+Shift+V can be assigned to another desktop action.
- **Diagnostic log:** `journalctl --user -b -o cat | rg 'ClipShelf|clipshelf'`. Do not share other applications' clipboard logs or your history directory when troubleshooting.

## Uninstall

```bash
./scripts/uninstall.sh                 # keeps history
./scripts/uninstall.sh --purge-data    # also deletes local clipboard history
```

The extension is disabled and removed from the enabled-login list before its files are removed. Other extensions and their settings are left alone. The optional purge removes only ClipShelf's data directory.
