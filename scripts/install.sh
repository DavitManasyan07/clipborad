#!/usr/bin/env bash
set -euo pipefail

uuid='clipshelf@local.davit'
activate=true
case "${1:-}" in
    '') ;;
    --no-enable) activate=false ;;
    -h|--help) printf 'Usage: %s [--no-enable]\nInstall ClipShelf for this user. By default, also enable it for GNOME login.\n' "$0"; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
if (($# > 1)); then printf 'Too many arguments.\n' >&2; exit 2; fi

source_root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
data_root=${XDG_DATA_HOME:-"$HOME/.local/share"}
case "$data_root" in /*) ;; *) printf 'XDG_DATA_HOME must be an absolute path.\n' >&2; exit 1 ;; esac
extension_root="$data_root/gnome-shell/extensions"
destination="$extension_root/$uuid"
for command in glib-compile-schemas gjs flock; do
    command -v "$command" >/dev/null || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
done
for entry in extension.js prefs.js metadata.json stylesheet.css LICENSE src icons schemas; do
    test -e "$source_root/$entry" || { printf 'Source is incomplete: missing %s\n' "$entry" >&2; exit 1; }
done
mkdir -p -- "$extension_root"
exec 9>"$extension_root/.clipshelf-install.lock"
flock -n 9 || { printf 'Another ClipShelf installation is running.\n' >&2; exit 1; }
if test -L "$destination"; then printf 'Refusing to replace a symbolic-link installation: %s\n' "$destination" >&2; exit 1; fi
"$source_root/scripts/build-native.sh"
native_build=${CLIPSHELF_BUILD_DIR:-"$source_root/build/native"}

stage=$(mktemp -d "$extension_root/.clipshelf-stage.XXXXXX")
backup=''
cleanup() {
    status=$?
    if test -n "$stage" && test -d "$stage"; then rm -rf -- "$stage"; fi
    if test -n "$backup" && test -d "$backup"; then
        if ! test -e "$destination"; then mv -- "$backup" "$destination"; else rm -rf -- "$backup"; fi
    fi
    exit "$status"
}
trap cleanup EXIT
for entry in extension.js prefs.js metadata.json stylesheet.css LICENSE src icons schemas; do
    cp -R -- "$source_root/$entry" "$stage/$entry"
done
mkdir -p -- "$stage/native"
cp -- "$native_build/libclipshelf-1.so" "$native_build/ClipShelf-1.0.typelib" "$stage/native/"
glib-compile-schemas --strict "$stage/schemas"
chmod -R u+rwX,go-rwx "$stage"
if test -e "$destination"; then
    backup=$(mktemp -d "$extension_root/.clipshelf-backup.XXXXXX")
    rmdir -- "$backup"
    mv -- "$destination" "$backup"
fi
mv -- "$stage" "$destination"
stage=''
printf 'Installed ClipShelf at %s\n' "$destination"

if "$activate"; then
    # Persist the login preference even when the running Shell has not discovered
    # a newly installed UUID yet. This never enables unrelated extensions.
    if ! GSETTINGS_SCHEMA_DIR=/usr/share/glib-2.0/schemas XDG_DATA_DIRS=/usr/local/share:/usr/share gjs -c 'const Gio = imports.gi.Gio; const settings = new Gio.Settings({schema_id: "org.gnome.shell"}); const uuid = "clipshelf@local.davit"; const enabled = settings.get_strv("enabled-extensions"); if (!enabled.includes(uuid)) { enabled.push(uuid); if (!settings.set_strv("enabled-extensions", enabled)) throw new Error("Cannot update GNOME extension settings"); } const disabled = settings.get_strv("disabled-extensions"); if (disabled.includes(uuid) && !settings.set_strv("disabled-extensions", disabled.filter(item => item !== uuid))) throw new Error("Cannot update disabled-extension settings"); Gio.Settings.sync(); if (settings.get_boolean("disable-user-extensions")) printerr("GNOME currently disables all user extensions. Enable extensions in the Extensions app to load ClipShelf.");'; then
        printf 'The files are installed, but login activation could not be saved. Run: gnome-extensions enable %s\n' "$uuid" >&2
        exit 1
    fi
    if command -v gnome-extensions >/dev/null && gnome-extensions enable "$uuid"; then
        printf 'ClipShelf is enabled. Open its panel icon or press Super+Shift+V.\n'
    else
        printf 'ClipShelf is configured to load at login. Log out and back in to let GNOME discover the new extension.\n'
    fi
    printf 'After updating an already loaded version, log out and back in to load the new JavaScript. This script never restarts your desktop.\n'
else
    printf 'Desktop activation was skipped (--no-enable).\n'
fi
