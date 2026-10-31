import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const FORMAT_VERSION = 1;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const HARD_MAX_ITEM_BYTES = 256 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Extension objects can be re-enabled before their previous async writes finish.
// Keep their commit sequence ordered even while the old store is draining.
const directoryQueues = new Map();

function existsError(error) {
    return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS);
}

function missingError(error) {
    return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

function info(file, attributes = 'standard::size,standard::type') {
    return new Promise((resolve, reject) => {
        file.query_info_async(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try { resolve(source.query_info_finish(result)); } catch (error) { reject(error); }
            });
    });
}

async function readBytes(file, maxBytes) {
    const stat = await info(file);
    if (stat.get_file_type() !== Gio.FileType.REGULAR || stat.get_size() > maxBytes)
        throw new Error('A history file exceeds the permitted size or has an invalid type.');
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [, contents] = source.load_contents_finish(result);
                if (contents.length > maxBytes)
                    throw new Error('A history file exceeds the permitted size.');
                resolve(contents);
            } catch (error) { reject(error); }
        });
    });
}

function writeBytes(file, bytes) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null, (source, result) => {
                try { source.replace_contents_finish(result); resolve(); } catch (error) { reject(error); }
            });
    });
}

function mkdir(file) {
    return new Promise((resolve, reject) => {
        file.make_directory_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try { source.make_directory_finish(result); resolve(); } catch (error) {
                if (existsError(error)) resolve(); else reject(error);
            }
        });
    });
}

async function ensureDirectory(file) {
    try {
        await mkdir(file);
    } catch (error) {
        if (!missingError(error) || !file.get_parent())
            throw error;
        await ensureDirectory(file.get_parent());
        await mkdir(file);
    }
}

function privateDirectory(file) {
    const attributes = new Gio.FileInfo();
    attributes.set_attribute_uint32('unix::mode', 0o700);
    return new Promise((resolve, reject) => {
        file.set_attributes_async(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try { source.set_attributes_finish(result); resolve(); } catch (error) { reject(error); }
            });
    });
}

function removeFile(file) {
    return new Promise((resolve, reject) => {
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try { source.delete_finish(result); resolve(); } catch (error) {
                if (missingError(error)) resolve(); else reject(error);
            }
        });
    });
}

function moveFile(source, destination) {
    return new Promise((resolve, reject) => {
        source.move_async(destination, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT,
            null, null, (file, result) => {
                try { file.move_finish(result); resolve(); } catch (error) { reject(error); }
            });
    });
}

async function children(file) {
    const enumerator = await new Promise((resolve, reject) => {
        file.enumerate_children_async('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null,
            (source, result) => {
                try { resolve(source.enumerate_children_finish(result)); } catch (error) { reject(error); }
            });
    });
    const entries = [];
    try {
        while (true) {
            const batch = await new Promise((resolve, reject) => {
                enumerator.next_files_async(32, GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    try { resolve(source.next_files_finish(result)); } catch (error) { reject(error); }
                });
            });
            if (!batch.length) break;
            entries.push(...batch);
        }
    } finally {
        await new Promise((resolve, reject) => {
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try { source.close_finish(result); resolve(); } catch (error) { reject(error); }
            });
        });
    }
    return entries;
}

async function removeTree(file) {
    let entries;
    try { entries = await children(file); } catch (error) {
        if (missingError(error)) return;
        throw error;
    }
    for (const child of entries) {
        const path = file.get_child(child.get_name());
        if (child.get_file_type() === Gio.FileType.DIRECTORY)
            await removeTree(path);
        else
            await removeFile(path);
    }
    await removeFile(file);
}

function yieldToShell() {
    return new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function digestRepresentations(representations) {
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    for (const mime of Object.keys(representations).sort()) {
        const bytes = representations[mime];
        checksum.update(encoder.encode(`${mime.length}:${mime}:${bytes.length}:`));
        for (let offset = 0; offset < bytes.length; offset += HASH_CHUNK_BYTES) {
            checksum.update(bytes.subarray(offset, offset + HASH_CHUNK_BYTES));
            if (offset + HASH_CHUNK_BYTES < bytes.length)
                await yieldToShell();
        }
    }
    return checksum.get_string();
}

function cleanCapture(capture) {
    if (!capture || !['text', 'image', 'files'].includes(capture.kind))
        throw new Error('The clipboard item has an unsupported type.');
    const representations = Object.create(null);
    let byteSize = 0;
    for (const [mime, value] of Object.entries(capture.representations ?? {})) {
        if (!mime || mime.length > 256 || Object.keys(representations).length >= 64 ||
            !(value instanceof Uint8Array))
            throw new Error('The clipboard item contains an invalid representation.');
        representations[mime] = new Uint8Array(value);
        byteSize += value.length;
    }
    if (!Object.keys(representations).length || !byteSize)
        throw new Error('The clipboard item is empty.');
    return {
        kind: capture.kind,
        text: String(capture.text ?? '').slice(0, 8192),
        files: Array.isArray(capture.files) ? capture.files.filter(uri =>
            typeof uri === 'string' && /^file:/iu.test(uri)) : [],
        representations,
        byteSize,
    };
}

/**
 * A serialized, asynchronous clipboard store. Payload files are immutable; the
 * atomically replaced index is the commit point. Orphan cleanup follows commit,
 * so interrupted writes never make the previous index reference missing files.
 */
export class HistoryStore {
    constructor({dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipshelf']),
        maxItems = 100, maxItemBytes = 16 * 1024 * 1024,
        maxTotalBytes = 128 * 1024 * 1024, onError = () => {}, onChange = () => {}} = {}) {
        this.directory = Gio.File.new_for_path(dataDir);
        this.payloadDirectory = this.directory.get_child('payloads');
        this.indexFile = this.directory.get_child('index.json');
        this.items = [];
        this._queue = Promise.resolve();
        this._closed = false;
        this._loaded = false;
        this.onError = onError;
        this.onChange = onChange;
        this._setLimits({maxItems, maxItemBytes, maxTotalBytes});
    }

    get totalBytes() {
        return this.items.reduce((sum, item) => sum + item.byteSize, 0);
    }

    _setLimits({maxItems = this.maxItems, maxItemBytes = this.maxItemBytes,
        maxTotalBytes = this.maxTotalBytes}) {
        for (const value of [maxItems, maxItemBytes, maxTotalBytes]) {
            if (!Number.isSafeInteger(value) || value <= 0)
                throw new Error('History limits must be positive whole numbers.');
        }
        this.maxItems = maxItems;
        this.maxItemBytes = Math.min(maxItemBytes, HARD_MAX_ITEM_BYTES);
        this.maxTotalBytes = maxTotalBytes;
    }

    _enqueue(operation) {
        if (this._closed)
            return Promise.reject(new Error('Clipboard history is closed.'));
        const key = this.directory.get_path();
        const previous = directoryQueues.get(key) ?? Promise.resolve();
        const result = previous.then(operation);
        const tail = result.catch(() => {});
        this._queue = tail;
        directoryQueues.set(key, tail);
        tail.then(() => {
            if (directoryQueues.get(key) === tail)
                directoryQueues.delete(key);
        });
        return result;
    }

    _notifyError(message) {
        try { this.onError(new Error(message)); } catch (_) { /* UI callbacks cannot break storage. */ }
    }

    _notifyChange() {
        try { this.onChange(this.items); } catch (_) { /* UI callbacks cannot break storage. */ }
    }

    async _initializeDirectory() {
        await ensureDirectory(this.directory);
        await privateDirectory(this.directory);
        await ensureDirectory(this.payloadDirectory);
        await privateDirectory(this.payloadDirectory);
    }

    load() {
        return this._enqueue(async () => {
            if (this._loaded) return this.items;
            await this._initializeDirectory();
            let raw;
            try { raw = await readBytes(this.indexFile, MAX_INDEX_BYTES); } catch (error) {
                if (!missingError(error)) throw new Error('Clipboard history could not be read. Check its permissions and size.');
                this._loaded = true;
                await this._commit([]);
                return this.items;
            }
            let index;
            try {
                index = JSON.parse(decoder.decode(raw));
                if (index.version !== FORMAT_VERSION || !Array.isArray(index.items) || index.items.length > 10000)
                    throw new Error('Invalid index.');
            } catch (_) {
                const stamp = Date.now();
                const backup = this.directory.get_child(`index.corrupt-${stamp}.json`);
                await writeBytes(backup, raw);
                const recovery = this.directory.get_child(`recovery-${stamp}`);
                await moveFile(this.payloadDirectory, recovery);
                await ensureDirectory(this.payloadDirectory);
                await privateDirectory(this.payloadDirectory);
                this._notifyError('A damaged history index and its payloads were preserved in index.corrupt-* and recovery-*. A new history was created.');
                this._loaded = true;
                await this._commit([]);
                return this.items;
            }
            const recovered = [];
            const damagedIds = new Set();
            let damaged = false;
            for (const metadata of index.items) {
                try {
                    if (!/^[a-f0-9]{64}$/.test(metadata.id) || !Array.isArray(metadata.formats) ||
                        !metadata.formats.length || metadata.formats.length > 64 ||
                        !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize > HARD_MAX_ITEM_BYTES)
                        throw new Error('Invalid metadata.');
                    const representations = Object.create(null);
                    const payloadPaths = Object.create(null);
                    const itemDir = this.payloadDirectory.get_child(metadata.id);
                    let size = 0;
                    for (let n = 0; n < metadata.formats.length; n++) {
                        const mime = metadata.formats[n];
                        if (typeof mime !== 'string' || !mime || mime.length > 256 || mime in representations)
                            throw new Error('Invalid format.');
                        const file = itemDir.get_child(`${n}.bin`);
                        const bytes = await readBytes(file, HARD_MAX_ITEM_BYTES - size);
                        representations[mime] = bytes;
                        payloadPaths[mime] = file.get_path();
                        size += bytes.length;
                    }
                    const capture = cleanCapture({...metadata, representations});
                    if (size !== metadata.byteSize || await digestRepresentations(representations) !== metadata.id)
                        throw new Error('Payload checksum mismatch.');
                    if (recovered.some(item => item.id === metadata.id))
                        continue;
                    recovered.push({...capture, id: metadata.id, digest: metadata.id,
                        createdAt: Number.isFinite(metadata.createdAt) ? metadata.createdAt : Date.now(),
                        lastUsed: Number.isFinite(metadata.lastUsed) ? metadata.lastUsed : Date.now(),
                        pinned: Boolean(metadata.pinned), payloadPaths});
                } catch (_) {
                    damaged = true;
                    if (/^[a-f0-9]{64}$/.test(metadata?.id))
                        damagedIds.add(metadata.id);
                }
            }
            if (damagedIds.size) {
                const recovery = this.directory.get_child(`recovery-${Date.now()}`);
                await ensureDirectory(recovery);
                await privateDirectory(recovery);
                for (const id of damagedIds) {
                    if (recovered.some(item => item.id === id)) continue;
                    try { await moveFile(this.payloadDirectory.get_child(id), recovery.get_child(id)); } catch (error) {
                        if (!missingError(error)) throw new Error('Damaged history payloads could not be preserved.');
                    }
                }
            }
            recovered.sort((a, b) => b.lastUsed - a.lastUsed);
            this._loaded = true;
            await this._commit(this._trim(recovered));
            if (damaged)
                this._notifyError('Some damaged history entries were skipped. Their payload files were kept for recovery.');
            return this.items;
        });
    }

    _trim(items, protectedId = null) {
        let result = [...items];
        let ordinary = 0;
        result = result.filter(item => item.pinned || ++ordinary <= this.maxItems || item.id === protectedId);
        let bytes = result.reduce((sum, item) => sum + item.byteSize, 0);
        for (let index = result.length - 1; bytes > this.maxTotalBytes && index >= 0; index--) {
            if (!result[index].pinned && result[index].id !== protectedId) {
                bytes -= result[index].byteSize;
                result.splice(index, 1);
            }
        }
        return result;
    }

    async _writePayloads(item) {
        const directory = this.payloadDirectory.get_child(item.id);
        await ensureDirectory(directory);
        await privateDirectory(directory);
        item.payloadPaths = Object.create(null);
        const formats = Object.keys(item.representations).sort();
        for (let n = 0; n < formats.length; n++) {
            const file = directory.get_child(`${n}.bin`);
            await writeBytes(file, item.representations[formats[n]]);
            item.payloadPaths[formats[n]] = file.get_path();
        }
    }

    async _commit(items, cleanup = true) {
        if (items.length > 10000)
            throw new Error('Clipboard history has reached its 10000-entry safety limit. Remove older entries before recording more.');
        const index = {version: FORMAT_VERSION, items: items.map(item => ({
            id: item.id, kind: item.kind, text: item.text, files: item.files,
            createdAt: item.createdAt, lastUsed: item.lastUsed, pinned: item.pinned,
            byteSize: item.byteSize, formats: Object.keys(item.representations).sort(),
        }))};
        const bytes = encoder.encode(JSON.stringify(index));
        if (bytes.length > MAX_INDEX_BYTES)
            throw new Error('Clipboard history metadata exceeds its 8 MiB safety limit. Remove older entries or reduce the history count.');
        try { await writeBytes(this.indexFile, bytes); } catch (_) {
            throw new Error('Clipboard history could not be saved. Check disk space and permissions.');
        }
        this.items = items;
        this._notifyChange();
        if (cleanup) {
            try { await this._cleanup(); } catch (_) {
                this._notifyError('Unused history payloads could not be removed. Check the history directory permissions.');
            }
        }
    }

    async _cleanup() {
        const keep = new Set(this.items.map(item => item.id));
        for (const entry of await children(this.payloadDirectory)) {
            if (/^[a-f0-9]{64}$/.test(entry.get_name()) && !keep.has(entry.get_name())) {
                const file = this.payloadDirectory.get_child(entry.get_name());
                if (entry.get_file_type() === Gio.FileType.DIRECTORY)
                    await removeTree(file);
                else
                    await removeFile(file);
            }
        }
    }

    add(capture) {
        return this._enqueue(async () => {
            if (!this._loaded) throw new Error('Clipboard history has not finished loading.');
            const clean = cleanCapture(capture);
            if (clean.byteSize > this.maxItemBytes)
                throw new Error('This clipboard item exceeds the per-item size limit.');
            const digest = await digestRepresentations(clean.representations);
            const existing = this.items.find(item => item.id === digest);
            const now = Date.now();
            if (existing) {
                const updated = {...existing, lastUsed: now};
                await this._commit([updated, ...this.items.filter(item => item.id !== digest)]);
                return updated;
            }
            const item = {...clean, id: digest, digest, pinned: false, createdAt: now, lastUsed: now};
            const next = this._trim([item, ...this.items], item.id);
            if (next.reduce((sum, entry) => sum + entry.byteSize, 0) > this.maxTotalBytes)
                throw new Error('Storage is full. Remove pinned items or raise the storage limit.');
            await this._writePayloads(item);
            await this._commit(next);
            return item;
        });
    }

    touch(id) {
        return this._enqueue(async () => {
            const existing = this.items.find(item => item.id === id);
            if (!existing) return null;
            const updated = {...existing, lastUsed: Date.now()};
            await this._commit([updated, ...this.items.filter(item => item.id !== id)]);
            return updated;
        });
    }

    togglePin(id) {
        return this._enqueue(async () => {
            const existing = this.items.find(item => item.id === id);
            if (!existing) return null;
            const updated = {...existing, pinned: !existing.pinned};
            const next = this.items.map(item => item.id === id ? updated : item);
            await this._commit(this._trim(next));
            return updated;
        });
    }

    remove(id) {
        return this._enqueue(() => this._commit(this.items.filter(item => item.id !== id)));
    }

    clear({includePinned = false} = {}) {
        return this._enqueue(async () => {
            await this._commit(includePinned ? [] : this.items.filter(item => item.pinned));
            if (includePinned) {
                for (const entry of await children(this.directory)) {
                    const name = entry.get_name();
                    const file = this.directory.get_child(name);
                    if (/^recovery-\d+$/.test(name) && entry.get_file_type() === Gio.FileType.DIRECTORY)
                        await removeTree(file);
                    else if (/^index\.corrupt-\d+\.json$/.test(name) && entry.get_file_type() === Gio.FileType.REGULAR)
                        await removeFile(file);
                }
            }
        });
    }

    configure(limits) {
        return this._enqueue(async () => {
            this._setLimits(limits);
            await this._commit(this._trim(this.items));
        });
    }

    /** Only checks original local references; never copies, moves, or deletes them. */
    async checkFiles(item, cancellable = null) {
        const missing = [];
        for (const uri of item.files ?? []) {
            if (cancellable?.is_cancelled())
                throw new Error('File availability check was cancelled.');
            try {
                await new Promise((resolve, reject) => {
                    Gio.File.new_for_uri(uri).query_info_async('standard::type',
                        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable,
                        (source, result) => {
                            try { source.query_info_finish(result); resolve(); } catch (error) { reject(error); }
                        });
                });
            } catch (_) {
                if (cancellable?.is_cancelled())
                    throw new Error('File availability check was cancelled.');
                missing.push(uri);
            }
        }
        return {available: missing.length === 0, missing};
    }

    async flush() {
        await this._queue;
    }

    async close() {
        this._closed = true;
        this.onChange = () => {};
        this.onError = () => {};
        await this._queue;
    }
}
