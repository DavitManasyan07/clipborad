/* SPDX-License-Identifier: GPL-2.0-or-later */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GIRepository from 'gi://GIRepository?version=2.0';
import Meta from 'gi://Meta';
import {isSensitive, selectMimes, normalizeCapture} from './payload.js';

let Native = null;
export function loadNativeBridge(nativeDir) {
    if (!Native) {
        GIRepository.Repository.prepend_search_path(nativeDir);
        GIRepository.Repository.prepend_library_path(nativeDir);
        imports.gi.versions.ClipShelf = '1.0';
        Native = imports.gi.ClipShelf;
    }
    return Native;
}

export function createSelectionSource(representations, nativeDir) {
    const source = loadNativeBridge(nativeDir).SelectionSource.new();
    for (const [mime, bytes] of Object.entries(representations))
        source.add(mime, new GLib.Bytes(bytes));
    return source;
}

function cancelled(error) {
    return error?.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
}

async function readSource(source, mime, maxBytes, cancellable, budget) {
    const stream = await new Promise((resolve, reject) => {
        source.read_async(mime, cancellable, (owner, result) => {
            try { resolve(owner.read_finish(result)); }
            catch (error) { reject(error); }
        });
    });
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const bytes = await new Promise((resolve, reject) => {
                stream.read_bytes_async(Math.min(65536, maxBytes + 1 - length),
                    GLib.PRIORITY_DEFAULT, cancellable, (input, result) => {
                        try { resolve(input.read_bytes_finish(result).toArray()); }
                        catch (error) { reject(error); }
                    });
            });
            if (!bytes.length)
                break;
            length += bytes.length;
            budget.used += bytes.length;
            if (length > maxBytes || budget.used > maxBytes) {
                budget.exceeded = true;
                cancellable.cancel();
                throw new Error('Clipboard item exceeds the per-item size limit.');
            }
            chunks.push(bytes);
        }
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    } finally {
        // Even after cancellation, close the stream asynchronously without reusing
        // the cancelled token. No extension callbacks remain attached to the stream.
        stream.close_async(GLib.PRIORITY_DEFAULT, null, (input, result) => {
            try { input.close_finish(result); } catch { /* already closed */ }
        });
    }
}

export class ClipboardMonitor {
    constructor({onCapture, onError = () => {}, getMaxBytes = () => 16 * 1024 * 1024,
        getPaused = () => false, nativeDir, selection = null}) {
        this._selection = selection ?? global.display.get_selection();
        this._onCapture = onCapture;
        this._onError = onError;
        this._getMaxBytes = getMaxBytes;
        this._getPaused = getPaused;
        this._nativeDir = nativeDir;
        this._signal = 0;
        this._generation = 0;
        this._cancellable = null;
        this._timeout = 0;
        this._ownSource = null;
        this._stopped = true;
    }

    start() {
        if (this._signal)
            return;
        loadNativeBridge(this._nativeDir);
        this._stopped = false;
        this._signal = this._selection.connect('owner-changed', (_selection, type, source) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
                return;
            this.cancelPending();
            if (this._stopped || this._getPaused() || !source || source === this._ownSource)
                return;
            this._capture(source, this._generation).catch(() => {
                // _capture reports only content-free messages. No clipboard data
                // or third-party provider exception text is ever sent to logs.
            });
        });
    }

    cancelPending() {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
    }

    async _capture(source, generation) {
        const mimes = source.get_mimetypes() ?? [];
        if (isSensitive(mimes))
            return;
        const selected = selectMimes(mimes);
        if (!selected.length)
            return;
        const token = new Gio.Cancellable();
        this._cancellable = token;
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8000, () => {
            if (this._timeout === timeout)
                this._timeout = 0;
            token.cancel();
            return GLib.SOURCE_REMOVE;
        });
        this._timeout = timeout;
        let timedOut = false;
        const limit = Math.max(1024, this._getMaxBytes());
        try {
            const raw = {};
            const budget = {used: 0, exceeded: false};
            // Start all reads against this exact owner. Provider replacement can
            // never mix bytes from two different clipboard generations.
            const results = await Promise.allSettled(selected.map(async mime => {
                const bytes = await readSource(source, mime, limit, token, budget);
                return [mime, bytes];
            }));
            if (generation !== this._generation || this._stopped || this._getPaused())
                return;
            timedOut = token.is_cancelled();
            let tooLarge = budget.exceeded;
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    const [mime, bytes] = result.value;
                    if (bytes.length)
                        raw[mime] = bytes;
                } else if (!cancelled(result.reason) && result.reason.message?.includes('size limit')) {
                    tooLarge = true;
                }
            }
            if (timedOut && !tooLarge) {
                this._onError('The clipboard source did not respond. Copy the item again.');
                return;
            }
            const item = normalizeCapture(raw);
            if (tooLarge || (item && Object.values(item.representations)
                .reduce((sum, bytes) => sum + bytes.length, 0) > limit)) {
                this._onError('This clipboard item exceeds the per-item size limit.');
                return;
            }
            if (!item) {
                this._onError('This clipboard format could not be read. Copy the item again.');
                return;
            }
            await this._onCapture(item);
        } catch {
            if (generation === this._generation && !this._stopped && !token.is_cancelled())
                this._onError('ClipShelf could not save this clipboard item.');
        } finally {
            if (this._timeout === timeout) {
                GLib.source_remove(timeout);
                this._timeout = 0;
            }
            if (this._cancellable === token)
                this._cancellable = null;
        }
    }

    restore(item) {
        if (!item?.representations || !Object.keys(item.representations).length)
            throw new Error('This history item has no available clipboard data.');
        this.cancelPending();
        const source = createSelectionSource(item.representations, this._nativeDir);
        // Set this first: set_owner emits owner-changed synchronously.
        this._ownSource = source;
        this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    stop() {
        this._stopped = true;
        this.cancelPending();
        if (this._signal) {
            this._selection.disconnect(this._signal);
            this._signal = 0;
        }
        // Native owner has no GJS callbacks and may safely outlive the extension.
        // Preserve the user's current clipboard when disabling or locking.
        this._ownSource = null;
    }
}
