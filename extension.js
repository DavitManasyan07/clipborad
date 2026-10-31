import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardMonitor} from './src/clipboard.js';
import {HistoryStore} from './src/history.js';
import {ClipShelfIndicator} from './src/ui.js';

export default class ClipShelf extends Extension {
    enable() {
        this._active = true;
        this._restoreChecks = new Gio.Cancellable();
        this._settings = this.getSettings();
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._store = new HistoryStore({
            dataDir: GLib.build_filenamev([GLib.get_user_data_dir(), 'clipshelf']),
            ...this._limits(),
            onChange: () => this._indicator?.refresh(),
            onError: error => this._showError(error),
        });
        const store = this._store;
        this._indicator = new ClipShelfIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            if (key === 'paused')
                this._syncPaused();
            else if (key === 'toggle-clipshelf')
                this._bindShortcut();
            else
                store.configure(this._limits()).catch(error => {
                    if (this._store === store)
                        this._showError(error);
                });
        });
        this._appearanceSignal = this._interfaceSettings.connect('changed::color-scheme',
            () => this._indicator?.syncAppearance());
        this._bindShortcut();
        // Load saved history before accepting new owners, avoiding a load/capture race.
        store.load().then(() => {
            if (!this._active || this._store !== store)
                return;
            this._monitor = new ClipboardMonitor({
                nativeDir: GLib.build_filenamev([this.path, 'native']),
                getMaxBytes: () => this._settings.get_int('max-item-mb') * 1024 * 1024,
                onCapture: capture => {
                    if (!this._active || this._store !== store)
                        return;
                    this._indicator?.showError('');
                    return store.add(capture).catch(error => {
                        if (this._store === store)
                            this._showError(error);
                    });
                },
                onError: error => {
                    if (this._store === store)
                        this._showError(error);
                },
            });
            this._syncPaused();
            this._indicator.refresh();
        }).catch(error => {
            if (this._store === store)
                this._showError(error);
        });
    }

    _limits() {
        return {
            maxItems: this._settings.get_int('max-items'),
            maxItemBytes: this._settings.get_int('max-item-mb') * 1024 * 1024,
            maxTotalBytes: this._settings.get_int('max-storage-mb') * 1024 * 1024,
        };
    }

    _syncPaused() {
        if (this._settings.get_boolean('paused'))
            this._monitor?.stop();
        else
            this._monitor?.start();
        this._indicator?.refresh();
    }

    _bindShortcut() {
        if (this._shortcutBound)
            Main.wm.removeKeybinding('toggle-clipshelf');
        this._shortcutBound = Main.wm.addKeybinding('toggle-clipshelf', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator?.menu.toggle());
    }

    _showError(error) {
        // Backend errors deliberately contain no clipboard contents or source URLs.
        if (this._active)
            this._indicator?.showError(error instanceof Error ? error.message :
                typeof error === 'string' ? error : 'Clipboard operation failed.');
    }

    async restore(item) {
        if (!this._monitor) {
            this._showError(new Error('Clipboard is still loading. Try again in a moment.'));
            return;
        }
        const indicator = this._indicator;
        const monitor = this._monitor;
        const store = this._store;
        try {
            if (item.kind === 'files') {
                const result = await store.checkFiles(item, this._restoreChecks);
                if (!result.available)
                    throw new Error('Original files are unavailable. They may have been moved or deleted.');
            }
            if (!this._active || monitor !== this._monitor || store !== this._store)
                return;
            await monitor.restore(item);
            if (!this._active || monitor !== this._monitor || store !== this._store)
                return;
            indicator.showError('');
            indicator.menu.close();
            await store.touch(item.id);
        } catch (error) {
            if (this._store === store)
                this._showError(error);
        }
    }

    disable() {
        this._active = false;
        this._restoreChecks?.cancel();
        this._restoreChecks = null;
        if (this._shortcutBound)
            Main.wm.removeKeybinding('toggle-clipshelf');
        this._shortcutBound = 0;
        if (this._settingsSignal)
            this._settings.disconnect(this._settingsSignal);
        if (this._appearanceSignal)
            this._interfaceSettings.disconnect(this._appearanceSignal);
        this._monitor?.stop();
        this._monitor?.destroy?.();
        this._monitor = null;
        this._indicator?.destroy();
        this._indicator = null;
        const store = this._store;
        this._store = null;
        // Each mutation is already committed atomically; finish any queued transaction.
        store?.close().catch(() => {});
        this._settings = null;
        this._interfaceSettings = null;
        this._settingsSignal = 0;
        this._appearanceSignal = 0;
    }
}
