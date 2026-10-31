#!/usr/bin/env bash
# A second, disposable compositor. Never connects to or changes the live desktop.
# Default keyboard coverage calls UI handlers deterministically. Set
# CLIPSHELF_SMOKE_VIRTUAL_KEYS=1 to exercise real virtual-seat events separately.
set -euo pipefail
source_root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
for required in dbus-run-session gnome-shell gsettings timeout python3; do
    command -v "$required" >/dev/null || { printf 'Missing tool: %s\n' "$required" >&2; exit 1; }
done
work=$(mktemp -d /tmp/clipshelf-shell-smoke.XXXXXX)
chmod 700 "$work"
export XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache"
export XDG_RUNTIME_DIR="$work/runtime" XDG_STATE_HOME="$work/state"
export XDG_DATA_DIRS=/usr/local/share:/usr/share GSETTINGS_SCHEMA_DIR=/usr/share/glib-2.0/schemas
export GSETTINGS_BACKEND=keyfile GNOME_SHELL_SESSION_MODE=user XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland
export CLIPSHELF_ISOLATED_SMOKE=1 CLIPSHELF_SMOKE_RESULT="$work/result.json" CLIPSHELF_SMOKE_SCREENSHOT="$work/popup.png"
export CLIPSHELF_TEST_WAYLAND_DISPLAY=clipshelf-test
export LIBGL_ALWAYS_SOFTWARE=1
export GIO_USE_VFS=local GTK_USE_PORTAL=0
unset DISPLAY WAYLAND_DISPLAY SESSION_MANAGER
# A terminal launched by a Snap editor can inherit Snap-only GIO/image loaders.
# They must never be injected into the system compositor under test.
unset GIO_MODULE_DIR GIO_EXTRA_MODULES GTK_PATH GTK_EXE_PREFIX GTK_DATA_PREFIX GTK_MODULES GTK_IM_MODULE_FILE
unset GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR LD_PRELOAD LD_LIBRARY_PATH GI_TYPELIB_PATH
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$XDG_STATE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
"$source_root/scripts/install.sh" --no-enable
extension="$XDG_DATA_HOME/gnome-shell/extensions/clipshelf@local.davit"
cp -- "$source_root/tests/shell-smoke.js" "$extension/shell-smoke.js"
cp -- "$source_root/tests/gtk-clipboard-client.js" "$extension/gtk-clipboard-client.js"
printf '\nimport {runSmoke} from "./shell-smoke.js";\nrunSmoke();\n' >> "$extension/extension.js"

printf 'Starting isolated GNOME Shell; test evidence: %s\n' "$work"
status=0
timeout --signal=TERM --kill-after=5s 90s dbus-run-session -- bash -c '
    set -euo pipefail
    gsettings set org.gnome.shell enabled-extensions "[\"clipshelf@local.davit\"]"
    gsettings set org.gnome.shell disabled-extensions "[]"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell welcome-dialog-last-shown-version 46.0
    gsettings set org.gnome.desktop.interface color-scheme "prefer-dark"
    gsettings set org.gnome.desktop.interface enable-animations false
    exec gnome-shell --headless --wayland --wayland-display "$CLIPSHELF_TEST_WAYLAND_DISPLAY" --virtual-monitor 1024x768 --no-x11 --sm-disable
' >"$work/shell.log" 2>&1 || status=$?
if ! test -f "$work/result.json"; then
    printf 'Shell smoke test did not produce a result (exit %s). Evidence retained: %s\n' "$status" "$work" >&2
    tail -80 "$work/shell.log" >&2
    exit 1
fi
cat "$work/result.json"
printf '\n'
if ! python3 -c 'import json,sys; sys.exit(not json.load(open(sys.argv[1]))["ok"])' "$work/result.json"; then
    printf 'Smoke test failed. Evidence retained: %s\n' "$work" >&2
    tail -60 "$work/shell.log" >&2
    exit 1
fi
if test "${CLIPSHELF_SMOKE_KEEP:-0}" = 1; then
    printf 'Passed. Evidence retained: %s\n' "$work"
else
    rm -rf -- "$work"
    printf 'Passed. Set CLIPSHELF_SMOKE_KEEP=1 to keep the screenshot and log.\n'
fi
