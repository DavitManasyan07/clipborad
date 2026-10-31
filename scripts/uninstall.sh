#!/usr/bin/env bash
set -euo pipefail

uuid='clipshelf@local.davit'
purge=false
case "${1:-}" in
    '') ;;
    --purge-data) purge=true ;;
    -h|--help) printf 'Usage: %s [--purge-data]\nDisable and remove ClipShelf for this user. History is kept unless --purge-data is supplied.\n' "$0"; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
if (($# > 1)); then printf 'Too many arguments.\n' >&2; exit 2; fi

data_root=${XDG_DATA_HOME:-"$HOME/.local/share"}
case "$data_root" in /*) ;; *) printf 'XDG_DATA_HOME must be an absolute path.\n' >&2; exit 1 ;; esac
destination="$data_root/gnome-shell/extensions/$uuid"
mkdir -p -- "$data_root/gnome-shell/extensions"
exec 9>"$data_root/gnome-shell/extensions/.clipshelf-install.lock"
flock -n 9 || { printf 'Another ClipShelf installation or removal is running.\n' >&2; exit 1; }
if command -v gjs >/dev/null; then
    GSETTINGS_SCHEMA_DIR=/usr/share/glib-2.0/schemas XDG_DATA_DIRS=/usr/local/share:/usr/share gjs -c '
        const {Gio, GLib} = imports.gi;
        const uuid = "clipshelf@local.davit";
        const bus = Gio.DBus.session;
        const [running] = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "NameHasOwner", new GLib.Variant("(s)", ["org.gnome.Shell"]),
            null, Gio.DBusCallFlags.NO_AUTO_START, 3000, null).deep_unpack();
        if (running)
            bus.call_sync("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
                "DisableExtension", new GLib.Variant("(s)", [uuid]), null,
                Gio.DBusCallFlags.NO_AUTO_START, 5000, null);
        const settings = new Gio.Settings({schema_id: "org.gnome.shell"});
        const enabled = settings.get_strv("enabled-extensions");
        if (!settings.set_strv("enabled-extensions", enabled.filter(item => item !== uuid)))
            throw new Error("Cannot update GNOME extension settings");
        Gio.Settings.sync();
    ' || {
        printf 'Could not remove the GNOME login setting. Run gnome-extensions disable %s in your desktop session.\n' "$uuid" >&2
        exit 1
    }
fi
if test -L "$destination"; then
    rm -- "$destination"
elif test -d "$destination"; then
    rm -rf -- "$destination"
fi
printf 'Removed ClipShelf.\n'
if "$purge"; then
    # Exact application-owned path; never remove the containing XDG directory.
    history="$data_root/clipshelf"
    if test -L "$history"; then rm -- "$history"; elif test -d "$history"; then rm -rf -- "$history"; fi
    printf 'Deleted ClipShelf history.\n'
else
    printf 'History is retained at %s/clipshelf. Use --purge-data to delete it.\n' "$data_root"
fi
