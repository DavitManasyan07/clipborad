# ClipShelf verification

Checked on October 31, 2026, on the requested laptop:

- Ubuntu 24.04.5 LTS, GNOME Shell 46.0, Mutter 46.2 / Meta 14.
- GJS 1.80.2, GTK 4.14, libadwaita 1.5; active desktop session: Ubuntu GNOME X11.
- Native API availability checked against installed typelibs, extracted matching
  public headers and the installed GNOME Shell JavaScript resources.

## Checks run

`./scripts/test.sh` passed 74 assertions: 42 clipboard/native and 32 storage.
It also compiled the C bridge with warnings treated as errors, validated the
settings schema and checked shell script syntax. Tests cover exact multi-format
streams, simultaneous readers, Unicode, rich text fallback, binary payloads,
source replacement, sensitive markers, pause/resume, duplicate suppression,
atomic persistence, corrupt data recovery, pinned quotas, all file references,
metadata safety limits and disable/re-enable storage races.

`./scripts/test-shell.sh` passed 62 assertions in a separate headless **GNOME 46
Wayland compositor**, using temporary XDG directories and a private D-Bus. It did
not restart or replace the user's active desktop. See the saved
[machine-readable result](wayland-smoke-result.json).

The integration test exercised a real GTK4 Wayland clipboard provider while the
popup was closed, terminated that provider, restored the saved entry, and started
a new GTK consumer. That consumer read the original Unicode, HTML and PNG bytes
and decoded the PNG into a 120 × 80 image texture. A separate file provider and
consumer verified copy-only Nautilus MIME data and all URI references. These are
actual GDK clipboard transfers, not a simulated Ctrl+V into Firefox or Nautilus.

The same compositor exercised the panel/popup, real thumbnail textures, all
filters, pinning, Down/Enter/Escape handlers, automatic search focus, pause/resume,
disable/re-enable persistence, retained native clipboard ownership, actual
libadwaita preferences construction and simulated lock-screen session modes.
Both [dark](preview-dark.png) and [light](preview-light.png) renderings were
visually inspected. Fixtures contain synthetic data only.

The default test routes key handling deterministically. A separate run with real
virtual-seat injection also passed 62 assertions; see its
[result](wayland-virtual-keys-result.json). That mode is opt-in with
`CLIPSHELF_SMOKE_VIRTUAL_KEYS=1` because headless input scheduling can vary. The
fixture waits for startup and, when necessary, completes the startup animation
only in the disposable compositor; neither saved passing run needed that fallback.
An actual login and physical desktop keyboard use remain manual checks.

`./scripts/test-install.sh` passed repeated installation and removal, native/schema
packaging, keeping history by default, explicit history purging and preserving an
unrelated extension. All of these mutations used temporary directories and private
settings.

## Installed state

Installed for this user at:

```text
/home/davit/.local/share/gnome-shell/extensions/clipshelf@local.davit
```

Verified that GNOME's `enabled-extensions` includes `clipshelf@local.davit`, its
`disabled-extensions` does not include it, and `disable-user-extensions` is false.
The running desktop has not discovered the new extension: **one logout/login is
required**. No logout, reboot or desktop restart was performed.
The 11 installed source/assets, native library, typelib and compiled schema were
checked against the final checkout after installation.

No system packages were changed. Build packages were downloaded and extracted
without administrator access; a reusable ignored SDK is in `build/sdk/root`.
The installed native library links to host GNOME libraries and has no SDK RPATH.

## Still requires the desktop

Use the exact checklist in [README.md](../README.md#verification) for copying from
Firefox and a terminal, pasting images into a desktop application, copying one and
multiple files into another Nautilus folder, real locking/unlocking, and automatic
startup/history after logout/login and reboot. The current active **X11** desktop's
clipboard workflow was not changed or used as an integration test.

Known format, storage, privacy and GNOME version limits are documented in the
README. The automated tests establish synthetic GTK/Mutter clipboard behavior;
they do not claim results for every application or an actual reboot.
