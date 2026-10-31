import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClipShelfPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Retain the settings object for the lifetime of this separate process.
        window._clipshelfSettings = settings;
        window.set_default_size(560, 640);

        const page = new Adw.PreferencesPage({
            title: 'ClipShelf',
            icon_name: 'edit-paste-symbolic',
        });
        window.add(page);

        const recording = new Adw.PreferencesGroup({
            title: 'Recording',
            description: 'Clipboard history stays on this computer. Only explicit copies are recorded.',
        });
        page.add(recording);
        const paused = new Adw.SwitchRow({
            title: 'Pause recording',
            subtitle: 'Existing history can still be searched and restored.',
        });
        settings.bind('paused', paused, 'active', Gio.SettingsBindFlags.DEFAULT);
        recording.add(paused);

        const storage = new Adw.PreferencesGroup({
            title: 'History and storage',
            description: 'Pinned items survive ordinary cleanup. When pinned data fills the storage limit, new items cannot be saved.',
        });
        page.add(storage);
        this._addSpin(storage, settings, 'max-items', 'History length',
            'Maximum number of unpinned entries', 10, 1000, 10);
        this._addSpin(storage, settings, 'max-item-mb', 'Maximum item size',
            'MiB, including all retained clipboard formats', 1, 128, 1);
        this._addSpin(storage, settings, 'max-storage-mb', 'Total storage limit',
            'MiB of clipboard payloads; oldest unpinned items are removed first', 16, 2048, 16);

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Keyboard',
            description: 'Use arrow keys to navigate, Enter to restore, and Escape to close.',
        });
        page.add(shortcuts);
        const shortcut = new Adw.EntryRow({
            title: 'Open ClipShelf',
            text: settings.get_strv('toggle-clipshelf')[0] ?? '',
            show_apply_button: true,
        });
        shortcut.connect('apply', () => {
            const text = shortcut.text.trim();
            const [valid, key, modifiers] = Gtk.accelerator_parse(text);
            if (text && (!valid || !Gtk.accelerator_valid(key, modifiers))) {
                shortcut.add_css_class('error');
                shortcut.set_tooltip_text('Enter an accelerator such as <Super><Shift>v, or leave blank to disable.');
                return;
            }
            shortcut.remove_css_class('error');
            shortcut.set_tooltip_text(null);
            settings.set_strv('toggle-clipshelf', text ? [Gtk.accelerator_name(key, modifiers)] : []);
        });
        shortcuts.add(shortcut);
        const shortcutHelp = new Adw.ActionRow({
            title: 'Shortcut format',
            subtitle: 'Default: Super+Shift+V. Leave the field blank to disable.',
            use_markup: false,
        });
        shortcuts.add(shortcutHelp);

        const privacy = new Adw.PreferencesGroup({title: 'Privacy'});
        privacy.add(new Adw.ActionRow({
            title: 'Local clipboard data',
            subtitle: 'History is stored unencrypted in your private user-data directory. Pause recording before copying secrets; sensitive-content markers are respected when provided by the source app.',
        }));
        page.add(privacy);
    }

    _addSpin(group, settings, key, title, subtitle, min, max, step) {
        const row = Adw.SpinRow.new_with_range(min, max, step);
        row.title = title;
        row.subtitle = subtitle;
        row.digits = 0;
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }
}
