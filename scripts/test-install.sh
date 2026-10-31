#!/usr/bin/env bash
# Exercises installation/removal under private settings and a private D-Bus.
set -euo pipefail
if [[ ${CLIPSHELF_INSTALL_TEST_CHILD:-0} != 1 ]]; then
    work=$(mktemp -d /tmp/clipshelf-install-test.XXXXXX)
    trap 'rm -rf -- "$work"' EXIT
    export XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config"
    export XDG_CACHE_HOME="$work/cache" XDG_RUNTIME_DIR="$work/runtime"
    export XDG_STATE_HOME="$work/state" GSETTINGS_BACKEND=keyfile
    export GIO_USE_VFS=local GTK_USE_PORTAL=0
    export XDG_DATA_DIRS=/usr/local/share:/usr/share GSETTINGS_SCHEMA_DIR=/usr/share/glib-2.0/schemas
    unset GIO_MODULE_DIR GIO_EXTRA_MODULES GTK_PATH GTK_EXE_PREFIX GTK_DATA_PREFIX GTK_MODULES GTK_IM_MODULE_FILE
    unset GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR LD_PRELOAD LD_LIBRARY_PATH GI_TYPELIB_PATH
    mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
    chmod 700 "$XDG_RUNTIME_DIR"
    dbus-run-session -- env CLIPSHELF_INSTALL_TEST_CHILD=1 bash "$0"
    exit 0
fi
source_root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
extension="$XDG_DATA_HOME/gnome-shell/extensions/clipshelf@local.davit"
other="$XDG_DATA_HOME/gnome-shell/extensions/keep-this-extension"
history="$XDG_DATA_HOME/clipshelf"
mkdir -p "$other" "$history"
printf 'disposable marker\n' > "$history/test-marker"
"$source_root/scripts/install.sh" --no-enable
test -f "$extension/extension.js"
test -f "$extension/native/libclipshelf-1.so"
test -f "$extension/native/ClipShelf-1.0.typelib"
test -f "$extension/schemas/gschemas.compiled"
test -f "$extension/LICENSE"
"$source_root/scripts/install.sh" --no-enable
"$source_root/scripts/uninstall.sh"
test ! -e "$extension"
test -f "$history/test-marker"
test -d "$other"
"$source_root/scripts/install.sh" --no-enable
"$source_root/scripts/uninstall.sh" --purge-data
test ! -e "$extension"
test ! -e "$history"
test -d "$other"
printf 'PASS: repeated installation, schema/native packaging, removal, history retention/purge, unrelated-extension preservation.\n'
