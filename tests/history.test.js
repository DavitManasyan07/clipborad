import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {HistoryStore} from '../src/history.js';

const encoder = new TextEncoder();
let assertions = 0;
function assert(condition, message) {
    assertions++;
    if (!condition) throw new Error(message);
}
function text(value) {
    return {kind: 'text', text: value, representations: {'text/plain': encoder.encode(value)}};
}
function write(file, value) {
    file.replace_contents(encoder.encode(value), null, false, Gio.FileCreateFlags.PRIVATE, null);
}
const root = GLib.dir_make_tmp('clipshelf-history-tests-XXXXXX');
const errors = [];
try {
    const dataDir = GLib.build_filenamev([root, 'nested', 'store']);
    let store = new HistoryStore({dataDir, maxItems: 2, maxItemBytes: 128,
        maxTotalBytes: 256, onError: error => errors.push(error.message)});
    await store.load();
    assert(store.items.length === 0, 'Fresh store must be empty.');
    const unicode = 'Բարև աշխարհ\nconst value = "hello";';
    const first = await store.add(text(unicode));
    await store.togglePin(first.id);
    await store.add(text('second'));
    await store.add(text('third'));
    await store.add(text('fourth'));
    assert(store.items.length === 3, 'Pinned entries must survive ordinary count cleanup.');
    assert(store.items.some(item => item.id === first.id && item.pinned), 'Pin must survive cleanup.');
    const duplicate = await store.add(text(unicode));
    assert(duplicate.id === first.id && duplicate.pinned, 'Duplicate must retain identity and pin.');
    assert(store.items[0].id === first.id && store.items.length === 3, 'Duplicate must move to front.');
    const binary = {kind: 'image', text: '', representations: {
        'image/png': new Uint8Array([0, 1, 2, 255]),
        'text/html': encoder.encode('<b>example</b>'),
    }};
    const image = await store.add(binary);
    assert(Object.keys(image.payloadPaths).length === 2, 'Each representation needs a disk payload.');
    await store.close();
    store = new HistoryStore({dataDir, maxItems: 2, maxItemBytes: 128,
        maxTotalBytes: 256, onError: error => errors.push(error.message)});
    await store.load();
    const restored = store.items.find(item => item.id === image.id);
    assert(restored.representations['image/png'][3] === 255, 'Binary image must round-trip exactly.');
    assert(new TextDecoder().decode(restored.representations['text/html']) === '<b>example</b>',
        'All MIME representations must persist.');
    assert(store.items.find(item => item.id === first.id).text === unicode, 'Unicode and multiline text must survive.');
    const stat = Gio.File.new_for_path(dataDir).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    assert((stat.get_attribute_uint32('unix::mode') & 0o777) === 0o700, 'History directory must be private.');
    await store.clear();
    assert(store.items.length === 1 && store.items[0].pinned, 'Clear must retain pinned by default.');
    await store.configure({maxTotalBytes: first.byteSize + 1});
    let rejected = false;
    try { await store.add(text('not enough room')); } catch (_) { rejected = true; }
    assert(rejected, 'Pinned capacity must reject incoming data rather than evict pins.');
    assert(store.items.length === 1, 'Failed capacity write must not change history.');
    await store.configure({maxTotalBytes: 256});
    await store.clear({includePinned: true});
    assert(store.items.length === 0, 'Explicit full clear must remove pins.');
    await store.configure({maxItems: 20});
    await Promise.all(Array.from({length: 12}, (_, n) => store.add(text(`rapid-${n}`))));
    assert(store.items.length === 12, 'Concurrent copies must serialize without lost entries.');
    assert(store.items[0].text === 'rapid-11', 'Concurrent copies must retain order.');
    await store.close();

    // A damaged payload should not prevent healthy entries from loading.
    const firstPayload = Gio.File.new_for_path(dataDir).get_child('payloads')
        .get_child(store.items[0].id).get_child('0.bin');
    write(firstPayload, 'damaged');
    store = new HistoryStore({dataDir, maxItems: 20, onError: error => errors.push(error.message)});
    await store.load();
    assert(store.items.length === 11, 'Corrupt payload must be skipped without discarding healthy entries.');
    assert(errors.some(message => message.includes('damaged history entries')), 'Corruption must be reported.');
    await store.close();

    write(Gio.File.new_for_path(dataDir).get_child('index.json'), '{broken json');
    store = new HistoryStore({dataDir, onError: error => errors.push(error.message)});
    await store.load();
    assert(store.items.length === 0, 'Corrupt index must recover to empty history.');
    assert(errors.some(message => message.includes('damaged history index')), 'Index recovery must be reported.');
    const enumerator = Gio.File.new_for_path(dataDir).enumerate_children('standard::name',
        Gio.FileQueryInfoFlags.NONE, null);
    let backup = false;
    for (let entry; (entry = enumerator.next_file(null));)
        backup ||= entry.get_name().startsWith('index.corrupt-');
    enumerator.close(null);
    assert(backup, 'Corrupt index must be preserved for recovery.');
    await store.add(text('new after recovery'));
    assert(store.items.length === 1, 'History must remain writable after corruption recovery.');
    await store.clear({includePinned: true});
    const afterClear = Gio.File.new_for_path(dataDir).enumerate_children('standard::name',
        Gio.FileQueryInfoFlags.NONE, null);
    let recoveryRemains = false;
    for (let entry; (entry = afterClear.next_file(null));)
        recoveryRemains ||= /^(index\.corrupt-|recovery-)/.test(entry.get_name());
    afterClear.close(null);
    assert(!recoveryRemains, 'Full clear must remove corruption recovery copies too.');
    await store.close();

    const fileDir = Gio.File.new_for_path(root).get_child('source');
    fileDir.make_directory(null);
    const source = fileDir.get_child('original.txt');
    write(source, 'source');
    const fileItem = {files: [source.get_uri()]};
    store = new HistoryStore({dataDir: GLib.build_filenamev([root, 'files'])});
    assert((await store.checkFiles(fileItem)).available, 'Existing original file must be available.');
    source.delete(null);
    assert(!(await store.checkFiles(fileItem)).available, 'Deleted file must become unavailable.');

    // A new extension instance must not read behind an old instance's draining commit.
    const toggleDir = GLib.build_filenamev([root, 'toggle']);
    const oldStore = new HistoryStore({dataDir: toggleDir});
    await oldStore.load();
    const pendingCapture = oldStore.add(text('queued before disable'));
    const draining = oldStore.close();
    const newStore = new HistoryStore({dataDir: toggleDir});
    await newStore.load();
    await Promise.all([pendingCapture, draining]);
    assert(newStore.items.length === 1 && newStore.items[0].text === 'queued before disable',
        'Rapid re-enable must load the previous instance’s final committed item.');
    const previousItems = newStore.items;
    const [, previousIndex] = newStore.indexFile.load_contents(null);
    let metadataRejected = false;
    try {
        // UTF8 byte length reaches 8MiB even though JavaScript string length does not.
        await newStore._commit([{...newStore.items[0], text: 'ա'.repeat(4 * 1024 * 1024)}]);
    } catch (error) { metadataRejected = error.message.includes('8 MiB safety limit'); }
    assert(metadataRejected, 'Serialized UTF8 metadata beyond the load safety limit must be rejected.');
    assert(newStore.items === previousItems, 'Rejected oversized index must leave in-memory history unchanged.');
    const [, unchangedIndex] = newStore.indexFile.load_contents(null);
    assert(unchangedIndex.length === previousIndex.length &&
        unchangedIndex.every((byte, n) => byte === previousIndex[n]),
    'Rejected oversized index must leave the previous atomic index byte-for-byte intact.');
    let entryCountRejected = false;
    try { await newStore._commit(Array.from({length: 10001}, () => newStore.items[0])); }
    catch (error) { entryCountRejected = error.message.includes('10000-entry safety limit'); }
    assert(entryCountRejected && newStore.items === previousItems,
        'Writer must reject an entry count that its own loader cannot read without altering saved history.');
    await newStore.close();

    const manyFilesDir = GLib.build_filenamev([root, 'many-files']);
    const manyFiles = Array.from({length: 10001}, (_, n) => `file:///tmp/clipshelf-reference-${n}`);
    const manyFilesStore = new HistoryStore({dataDir: manyFilesDir});
    await manyFilesStore.load();
    const manyFilesItem = await manyFilesStore.add({kind: 'files', text: '10001 files', files: manyFiles,
        representations: {'x-special/gnome-copied-files': encoder.encode(`copy\n${manyFiles.join('\n')}`)}});
    assert(manyFilesItem.files.length === manyFiles.length && manyFilesItem.files.at(-1) === manyFiles.at(-1),
        'File metadata must not silently omit references that are present in the clipboard payload.');
    await manyFilesStore.close();
    const manyFilesReloaded = new HistoryStore({dataDir: manyFilesDir});
    await manyFilesReloaded.load();
    assert(manyFilesReloaded.items[0].files.length === 10001 &&
        manyFilesReloaded.items[0].files.at(-1) === manyFiles.at(-1),
    'Every file reference must survive persistence for availability checks and accurate item counts.');
    await manyFilesReloaded.close();
    print(`PASS: ${assertions} history assertions`);
} finally {
    // Tests only remove the unique temporary root they created.
    const process = Gio.Subprocess.new(['rm', '-rf', '--', root], Gio.SubprocessFlags.NONE);
    process.wait_check(null);
}
