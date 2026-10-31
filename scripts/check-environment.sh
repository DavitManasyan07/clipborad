#!/usr/bin/env bash
set -u

printf 'Operating system:\n'
if test -r /etc/os-release; then . /etc/os-release; printf '  %s\n' "$PRETTY_NAME"; fi
printf 'Installed desktop libraries:\n'
gnome-shell --version 2>/dev/null || true
gjs --version 2>/dev/null || true
printf 'Session type: %s\nDesktop: %s\n' "${XDG_SESSION_TYPE:-unknown}" "${XDG_CURRENT_DESKTOP:-unknown}"
if test -n "${GSETTINGS_SCHEMA_DIR:-}"; then printf 'Inherited schema override: %s (system schemas are used for diagnostics)\n' "$GSETTINGS_SCHEMA_DIR"; fi
printf 'Running Shell version:\n'
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.freedesktop.DBus.Properties.Get org.gnome.Shell ShellVersion 2>&1 || true
printf 'ClipShelf extension status:\n'
gnome-extensions info clipshelf@local.davit 2>&1 || true
printf 'Preferences dependencies:\n'
GSETTINGS_SCHEMA_DIR=/usr/share/glib-2.0/schemas XDG_DATA_DIRS=/usr/local/share:/usr/share gjs -c 'imports.gi.versions.Gtk = "4.0"; imports.gi.versions.Adw = "1"; const {Gtk, Adw} = imports.gi; print("GTK " + Gtk.get_major_version() + "." + Gtk.get_minor_version()); print("libadwaita " + Adw.get_major_version() + "." + Adw.get_minor_version());' 2>&1 || true
