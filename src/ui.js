import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

function iconButton(iconName, label, callback, style = '') {
    const button = new St.Button({
        style_class: `clipshelf-icon-button ${style}`,
        can_focus: true, track_hover: true, accessible_name: label,
        child: new St.Icon({icon_name: iconName, icon_size: 16}),
    });
    button.connect('clicked', callback);
    return button;
}

function filename(uri) {
    try {
        return Gio.File.new_for_uri(uri).get_basename() || uri;
    } catch {
        return 'File';
    }
}

function relativeTime(timestamp) {
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1)
        return 'Just now';
    if (minutes < 60)
        return `${minutes}m ago`;
    if (minutes < 1440)
        return `${Math.floor(minutes / 60)}h ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
}

function title(item) {
    if (item.kind === 'files')
        return item.files.slice(0, 3).map(filename).join(', ') +
            (item.files.length > 3 ? `, +${item.files.length - 3} more` : '');
    if (item.kind === 'image')
        return item.text || 'Copied image';
    return item.text?.trim() || 'Empty text';
}

export const ClipShelfIndicator = GObject.registerClass(
class ClipShelfIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'ClipShelf — clipboard history');
        this._extension = extension;
        this._filter = 'all';
        this._selected = -1;
        this._rows = [];
        this._revision = 0;
        this._destroyed = false;
        this._dialog = null;
        this._focusIdle = 0;
        this._fileChecks = null;
        this._error = '';
        this.add_child(new St.Icon({
            gicon: new Gio.FileIcon({file: extension.dir.get_child('icons/clipshelf-symbolic.svg')}),
            style_class: 'system-status-icon',
        }));
        this.menu.actor.add_style_class_name('clipshelf-popup');
        this.menu.box.add_style_class_name('clipshelf-content');
        this._buildHeader();
        this._buildSearch();
        this._buildFilters();
        this._notice = new St.Label({style_class: 'clipshelf-notice', visible: false});
        this._notice.clutter_text.line_wrap = true;
        this.menu.box.add_child(this._notice);
        this._scroll = new St.ScrollView({
            style_class: 'clipshelf-scroll', overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        this._list = new St.BoxLayout({vertical: true, style_class: 'clipshelf-list', x_expand: true});
        this._scroll.set_child(this._list);
        this.menu.box.add_child(this._scroll);
        this._buildFooter();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._sizeToMonitor();
                this.refresh();
                // The panel's menu manager takes its modal grab after this
                // signal handler; focus the entry once that grab is established.
                this._focusIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._focusIdle = 0;
                    if (!this._destroyed && this.menu.isOpen)
                        global.stage.set_key_focus(this._search.clutter_text);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._cancelFocusIdle();
                this._revision++;
                this._fileChecks?.cancel();
                this._fileChecks = null;
                this._search.set_text('');
                this._selected = -1;
            }
        });
        this.menu.actor.connect('captured-event', (_actor, event) => this._keyEvent(event));
        this.syncAppearance();
        this.refresh();
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'clipshelf-header', x_expand: true});
        const labels = new St.BoxLayout({vertical: true, x_expand: true});
        labels.add_child(new St.Label({text: 'ClipShelf', style_class: 'clipshelf-title'}));
        this._subtitle = new St.Label({text: 'Your clipboard, within reach', style_class: 'clipshelf-subtitle'});
        labels.add_child(this._subtitle);
        header.add_child(labels);
        this._pause = iconButton('media-playback-pause-symbolic', 'Pause recording', () => {
            const settings = this._extension._settings;
            settings.set_boolean('paused', !settings.get_boolean('paused'));
        });
        header.add_child(this._pause);
        header.add_child(iconButton('emblem-system-symbolic', 'ClipShelf preferences', () => {
            this.menu.close();
            this._extension.openPreferences();
        }));
        this.menu.box.add_child(header);
    }

    _buildSearch() {
        this._search = new St.Entry({
            style_class: 'clipshelf-search', hint_text: 'Search your clipboard…',
            can_focus: true, x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16}),
            accessible_name: 'Search clipboard history',
        });
        this._search.clutter_text.connect('text-changed', () => this.refresh());
        this.menu.box.add_child(this._search);
    }

    _buildFilters() {
        const filters = new St.BoxLayout({style_class: 'clipshelf-filters', x_expand: true});
        this._filters = [];
        for (const [value, label] of [['all', 'All'], ['text', 'Text'], ['image', 'Images'], ['files', 'Files'], ['pinned', 'Pinned']]) {
            const button = new St.Button({label, can_focus: true, track_hover: true,
                style_class: 'clipshelf-filter', x_expand: true, accessible_name: `${label} filter`});
            button.connect('clicked', () => {
                this._filter = value;
                this.refresh();
            });
            filters.add_child(button);
            this._filters.push([value, button]);
        }
        this.menu.box.add_child(filters);
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'clipshelf-footer', x_expand: true});
        this._count = new St.Label({style_class: 'clipshelf-meta', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._count);
        const clear = new St.Button({label: 'Clear history', style_class: 'clipshelf-clear',
            can_focus: true, track_hover: true, accessible_name: 'Clear unpinned clipboard history'});
        clear.connect('clicked', () => this._confirmClear());
        footer.add_child(clear);
        this.menu.box.add_child(footer);
        this.menu.box.add_child(new St.Label({text: '↑ ↓ Browse    ↵ Copy    Esc Close', style_class: 'clipshelf-keyboard-hint'}));
    }

    syncAppearance() {
        const dark = this._extension._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        this.menu.actor.remove_style_class_name(dark ? 'clipshelf-light' : 'clipshelf-dark');
        this.menu.actor.add_style_class_name(dark ? 'clipshelf-dark' : 'clipshelf-light');
    }

    _sizeToMonitor() {
        const monitor = Main.layoutManager.findMonitorForActor(this) || Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.max(200, Math.min(420, monitor.width / scale - 32));
        // St's width is the content width; include padding and border in 420px.
        this.menu.box.set_style(`width: ${width - 38}px;`);
        const height = Math.max(64, Math.min(390, monitor.height / scale - 320));
        this._scroll.set_style(`min-height: ${Math.min(180, height)}px; max-height: ${height}px;`);
    }

    showError(message) {
        if (this._destroyed)
            return;
        this._error = message;
        this._syncNotice();
    }

    _syncNotice() {
        const paused = this._extension._settings.get_boolean('paused');
        this._notice.text = this._error || (paused ? 'Recording paused. Your saved items are still available.' : '');
        this._notice.visible = Boolean(this._notice.text);
        this._pause.child.icon_name = paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        this._pause.accessible_name = paused ? 'Resume recording' : 'Pause recording';
        this._subtitle.text = paused ? 'Recording paused' : 'Your clipboard, within reach';
        if (paused)
            this.add_style_class_name('clipshelf-paused');
        else
            this.remove_style_class_name('clipshelf-paused');
    }

    refresh() {
        if (this._destroyed)
            return;
        this._syncNotice();
        const store = this._extension._store;
        const all = store?.items || [];
        this._count.text = `${all.length} ${all.length === 1 ? 'item' : 'items'} · ${Math.round((store?.totalBytes || 0) / 1024 / 1024 * 10) / 10} MB`;
        for (const [value, button] of this._filters) {
            if (this._filter === value)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        // Rebuild only while open; clipboard monitoring remains active at all times.
        if (!this.menu.isOpen)
            return;
        const revision = ++this._revision;
        this._fileChecks?.cancel();
        this._fileChecks = new Gio.Cancellable();
        this._list.destroy_all_children();
        this._rows = [];
        this._selected = -1;
        const query = this._search.get_text().toLocaleLowerCase();
        const filtered = all.filter(item =>
            (this._filter === 'all' || (this._filter === 'pinned' ? item.pinned : item.kind === this._filter)) &&
            `${title(item)} ${item.text || ''} ${(item.files || []).join(' ')}`.toLocaleLowerCase().includes(query));
        if (!filtered.length) {
            const empty = new St.BoxLayout({vertical: true, style_class: 'clipshelf-empty'});
            empty.add_child(new St.Icon({icon_name: query ? 'edit-find-symbolic' : 'edit-paste-symbolic', icon_size: 36, style_class: 'clipshelf-empty-icon'}));
            empty.add_child(new St.Label({text: query ? 'No matching clips' : this._filter === 'pinned' ? 'Keep the useful things' : 'A fresh start', style_class: 'clipshelf-empty-title'}));
            const detail = new St.Label({text: query ? 'Try another word or a different filter.' : this._filter === 'pinned' ? 'Pin a clip to keep it here.' : 'Copy text, an image, or a file.\nIt will be waiting for you here.', style_class: 'clipshelf-empty-detail'});
            detail.clutter_text.line_wrap = true;
            empty.add_child(detail);
            this._list.add_child(empty);
        }
        for (const item of filtered)
            this._addRow(item, revision);
    }

    _addRow(item, revision) {
        const row = new St.BoxLayout({style_class: 'clipshelf-row', x_expand: true});
        const content = new St.BoxLayout({style_class: 'clipshelf-row-content', x_expand: true});
        const preview = new St.Bin({style_class: 'clipshelf-preview', y_align: Clutter.ActorAlign.CENTER});
        const imageMime = Object.keys(item.representations).find(mime => /^(image\/png|image\/jpeg|image\/webp|image\/gif)$/.test(mime));
        if (item.kind === 'image' && imageMime && item.payloadPaths?.[imageMime]) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            preview.child = St.TextureCache.get_default().load_file_async(
                Gio.File.new_for_path(item.payloadPaths[imageMime]), 52, 44, scale, 1);
        } else {
            preview.child = new St.Icon({icon_name: item.kind === 'files' ? 'folder-symbolic' :
                item.kind === 'image' ? 'image-x-generic-symbolic' : /^https?:\/\//.test(item.text || '') ?
                    'web-browser-symbolic' : 'text-x-generic-symbolic', icon_size: 22});
        }
        content.add_child(preview);
        const labels = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const snippet = new St.Label({text: title(item).replace(/\s+/gu, ' ').slice(0, 240),
            style_class: 'clipshelf-snippet', x_expand: true});
        snippet.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labels.add_child(snippet);
        const type = item.kind === 'files' ? `${item.files.length} ${item.files.length === 1 ? 'file or folder' : 'files / folders'}` :
            item.kind === 'image' ? 'Image' : Object.keys(item.representations).some(mime => mime === 'text/html') ? 'Rich text' : 'Text';
        const meta = new St.Label({text: `${item.pinned ? 'Pinned · ' : ''}${type} · ${relativeTime(item.lastUsed || item.createdAt)}`,
            style_class: 'clipshelf-meta', x_expand: true});
        meta.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labels.add_child(meta);
        content.add_child(labels);
        const select = new St.Button({child: content, can_focus: true, track_hover: true,
            style_class: 'clipshelf-select', x_expand: true, accessible_name: `Copy ${title(item).slice(0, 100)}`});
        select.connect('clicked', () => this._extension.restore(item));
        select.connect('key-focus-in', () => this._highlight(this._rows.findIndex(entry => entry.item.id === item.id)));
        row.add_child(select);
        const actions = new St.BoxLayout({style_class: 'clipshelf-actions', y_align: Clutter.ActorAlign.CENTER});
        actions.add_child(iconButton('view-pin-symbolic', item.pinned ? 'Unpin clip' : 'Pin clip', () => {
            this._extension._store.togglePin(item.id).catch(error => this.showError(error.message));
        }, item.pinned ? 'clipshelf-pinned' : 'clipshelf-pin'));
        actions.add_child(iconButton('user-trash-symbolic', 'Delete clip', () => {
            this._extension._store.remove(item.id).catch(error => this.showError(error.message));
        }));
        row.add_child(actions);
        this._list.add_child(row);
        this._rows.push({row, select, item});
        if (item.kind === 'files') {
            this._extension._store.checkFiles(item, this._fileChecks).then(result => {
                if (this._destroyed || this._revision !== revision)
                    return;
                if (!result.available) {
                    meta.text = `Unavailable · ${result.missing.length} missing`;
                    row.add_style_class_name('clipshelf-unavailable');
                    select.accessible_name = 'Original files are unavailable';
                }
            }).catch(() => {});
        }
    }

    _highlight(index) {
        if (index < 0 || index >= this._rows.length)
            return;
        for (const [i, entry] of this._rows.entries()) {
            if (i === index)
                entry.row.add_style_pseudo_class('selected');
            else
                entry.row.remove_style_pseudo_class('selected');
        }
        this._selected = index;
        const box = this._rows[index].row.get_allocation_box();
        const adjustment = this._scroll.vadjustment;
        if (box.y1 < adjustment.value)
            adjustment.value = box.y1;
        else if (box.y2 > adjustment.value + adjustment.page_size)
            adjustment.value = Math.min(adjustment.upper - adjustment.page_size, box.y2 - adjustment.page_size);
    }

    _cancelFocusIdle() {
        if (this._focusIdle) {
            GLib.source_remove(this._focusIdle);
            this._focusIdle = 0;
        }
    }

    _keyEvent(event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.menu.close();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Up) {
            const direction = symbol === Clutter.KEY_Down ? 1 : -1;
            const index = this._selected < 0 ? (direction > 0 ? 0 : this._rows.length - 1) :
                (this._selected + direction + this._rows.length) % this._rows.length;
            if (this._rows[index]) {
                this._highlight(index);
                this._rows[index].select.grab_key_focus();
            }
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) &&
            global.stage.get_key_focus() === this._search.clutter_text && this._rows.length) {
            this._extension.restore(this._rows[Math.max(0, this._selected)].item);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _confirmClear() {
        this.menu.close();
        if (this._dialog)
            return;
        const dialog = new ModalDialog.ModalDialog({styleClass: 'clipshelf-confirm'});
        this._dialog = dialog;
        dialog.contentLayout.add_child(new St.Label({text: 'Clear clipboard history?', style_class: 'clipshelf-title'}));
        const detail = new St.Label({text: 'Unpinned clips will be permanently deleted.\nYour pinned clips will stay.', style_class: 'clipshelf-confirm-detail'});
        detail.clutter_text.line_wrap = true;
        dialog.contentLayout.add_child(detail);
        dialog.setButtons([
            {label: 'Cancel', key: Clutter.KEY_Escape, action: () => dialog.close()},
            {label: 'Clear history', default: true, action: () => {
                this._extension._store.clear({includePinned: false}).catch(error => this.showError(error.message));
                dialog.close();
            }},
        ]);
        dialog.connect('destroy', () => { this._dialog = null; });
        dialog.open();
    }

    destroy() {
        this._destroyed = true;
        this._cancelFocusIdle();
        this._revision++;
        this._fileChecks?.cancel();
        this._fileChecks = null;
        this._dialog?.destroy();
        this._dialog = null;
        super.destroy();
        this._extension = null;
    }
});
