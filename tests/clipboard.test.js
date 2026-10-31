/* Headless tests: exact native multi-MIME streams, no desktop clipboard changes. */
import GLib from 'gi://GLib';
import Meta from 'gi://Meta?version=14';
import {ClipboardMonitor, createSelectionSource} from '../src/clipboard.js';
import {normalizeCapture, selectMimes, isSensitive} from '../src/payload.js';

const nativeDir = GLib.build_filenamev([GLib.get_current_dir(), 'build', 'native']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let assertions = 0;
function assert(ok, message) {
    assertions++;
    if (!ok) throw new Error(message);
}
function delay(ms = 25) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve(); return GLib.SOURCE_REMOVE;
    }));
}
async function read(source, mime) {
    const stream = await new Promise((resolve, reject) => source.read_async(mime, null,
        (owner, result) => { try { resolve(owner.read_finish(result)); } catch (error) { reject(error); } }));
    const bytes = stream.read_bytes(65536, null).toArray();
    stream.close(null);
    return bytes;
}
class FakeSelection {
    connect(_signal, callback) { this.callback = callback; return 1; }
    disconnect() { this.callback = null; }
    emit(source, type = Meta.SelectionType.SELECTION_CLIPBOARD) { this.callback?.(this, type, source); }
    set_owner(_type, source) { this.owner = source; this.emit(source); }
}

assert(isSensitive(['text/plain', 'x-kde-passwordManagerHint']), 'Password marker must suppress capture.');
assert(isSensitive(['application/x-keepassxc']), 'KeePassXC marker must suppress capture.');
assert(!isSensitive(['text/plain']), 'Ordinary text must not be sensitive.');
assert(selectMimes(['image/png', 'image/jpeg', 'text/plain', 'text/html']).join(',') ===
    'text/plain,image/png,text/html', 'Choose bounded relevant representations.');
const unicode = 'Բարև աշխարհ\nconst x = "hello";';
const text = normalizeCapture({'UTF8_STRING': encoder.encode(unicode)});
assert(text.text === unicode && text.kind === 'text', 'Unicode/multiline text must normalize losslessly.');
assert(decoder.decode(text.representations['text/plain']) === unicode, 'Plain fallback must preserve UTF8.');
const rich = normalizeCapture({'text/html': encoder.encode('<b>Hello</b><br>world &amp; friends')});
assert(rich.text === 'Hello\nworld & friends', 'HTML-only source needs a plain fallback.');
assert(decoder.decode(rich.representations['text/html']).startsWith('<b>'), 'Original HTML must remain exact.');
const numericHtml = normalizeCapture({'text/html': encoder.encode('&#1330;&#x561;&#x100000; &#0; &#xD800; &amp;lt;')});
assert(numericHtml.text === `Բա${String.fromCodePoint(0x100000)} \ufffd \ufffd &lt;`,
    'HTML fallback must decode decimal/hex Unicode and replace invalid scalar values once.');
const scriptHeavyHtml = encoder.encode('Visible text<script>'.repeat(25000));
const scriptStart = GLib.get_monotonic_time();
const scriptHeavy = normalizeCapture({'text/html': scriptHeavyHtml});
assert(scriptHeavy.text === 'Visible text', 'Unterminated script content must not enter the text fallback.');
assert(scriptHeavy.representations['text/html'] === scriptHeavyHtml,
    'Fallback conversion must retain the complete original HTML representation.');
assert(GLib.get_monotonic_time() - scriptStart < 1000000,
    'Repeated unmatched HTML tags must finish without quadratic backtracking.');
const cut = normalizeCapture({'x-special/gnome-copied-files':
    encoder.encode('cut\nfile:///tmp/a%20b\nfile:///tmp/c')});
assert(cut.kind === 'files' && cut.files.length === 2, 'Multiple file references must survive.');
assert(decoder.decode(cut.representations['x-special/gnome-copied-files']).startsWith('copy\n'),
    'Historical cut must restore copy semantics.');
assert(decoder.decode(cut.representations['text/uri-list']) === 'file:///tmp/a%20b\r\nfile:///tmp/c\r\n',
    'URI list must preserve encoded paths with CRLF lines.');
assert(cut.text === '/tmp/a b\n/tmp/c', 'File plain fallback should be readable.');
const url = normalizeCapture({'text/uri-list': encoder.encode('https://example.org/\r\n'),
    'text/plain': encoder.encode('https://example.org/')});
assert(url.kind === 'text', 'An HTTP URL should not become a file operation.');
const uriOnlyBytes = encoder.encode('https://example.org/\r\nhttps://example.org/other\r\n');
const uriOnly = normalizeCapture({'text/uri-list': uriOnlyBytes});
assert(uriOnly.kind === 'text' && decoder.decode(uriOnly.representations['text/plain']) ===
    'https://example.org/\nhttps://example.org/other' && uriOnly.representations['text/uri-list'] === uriOnlyBytes,
    'URI-only HTTP URLs must retain URI bytes and publish a usable plain fallback.');
assert(normalizeCapture({'text/rtf': encoder.encode('{\\rtf1 Hello}')} ) === null,
    'RTF-only sources must not claim a usable plain fallback.');
assert(normalizeCapture({'x-special/gnome-copied-files': encoder.encode('copy\nsftp://example.org/file')}) === null,
    'Remote file operations must not be silently restored as local files.');
const imageBytes = new Uint8Array([137, 80, 78, 71, 0, 255, 128]);
const image = normalizeCapture({'image/png': imageBytes});
assert(image.kind === 'image' && image.representations['image/png'] === imageBytes,
    'Image bytes must not be converted to text.');
const representations = {'text/plain': encoder.encode(unicode), 'text/html': encoder.encode('<b>Hello</b>'),
    'image/png': imageBytes, ...cut.representations};
const source = createSelectionSource(representations, nativeDir);
assert(source instanceof Meta.SelectionSource, 'Native source must inherit real Meta.SelectionSource.');
assert(source.get_mimetypes().length === Object.keys(representations).length,
    'A single owner must advertise all representations simultaneously.');
for (const [mime, expected] of Object.entries(representations)) {
    const actual = await read(source, mime);
    assert(actual.length === expected.length && actual.every((byte, i) => byte === expected[i]),
        `Native MIME bytes must round-trip: ${mime}`);
}
const parallel = await Promise.all([read(source, 'image/png'), read(source, 'text/html')]);
assert(parallel[0][5] === 255 && decoder.decode(parallel[1]) === '<b>Hello</b>',
    'Independent simultaneous requests must read their own MIME streams.');
let unsupported = false;
try { await read(source, 'application/not-supported'); } catch { unsupported = true; }
assert(unsupported, 'Unknown format must fail safely.');

const selection = new FakeSelection();
const captures = [], errors = [];
let paused = false;
const monitor = new ClipboardMonitor({selection, nativeDir, getPaused: () => paused,
    getMaxBytes: () => 4096, onCapture: item => captures.push(item), onError: message => errors.push(message)});
monitor.start();
selection.emit(createSelectionSource({'text/plain': encoder.encode('first')}, nativeDir));
await delay();
assert(captures.length === 1 && captures[0].text === 'first', 'Closed-popup monitor must capture owner changes.');
selection.emit(source, Meta.SelectionType.SELECTION_PRIMARY);
await delay();
assert(captures.length === 1, 'Mouse PRIMARY selection must be ignored.');
selection.emit(createSelectionSource({'text/plain': encoder.encode('secret'),
    'x-kde-passwordManagerHint': encoder.encode('secret')}, nativeDir));
await delay();
assert(captures.length === 1, 'Sensitive clipboard owner must not be saved.');
paused = true;
selection.emit(source);
await delay();
assert(captures.length === 1, 'Paused monitor must not record copies.');
paused = false;
monitor.restore(cut);
await delay();
assert(captures.length === 1, 'Restoring an item must not cause a capture loop.');
assert(decoder.decode(await read(selection.owner, 'x-special/gnome-copied-files')).startsWith('copy\n'),
    'Restore must publish real file-copy bytes.');
for (let i = 0; i < 20; i++)
    selection.emit(createSelectionSource({'text/plain': encoder.encode(`rapid-${i}`)}, nativeDir));
await delay(80);
assert(captures.at(-1).text === 'rapid-19', 'Rapid ownership changes must retain newest complete payload.');
selection.emit(createSelectionSource({'text/plain': encoder.encode('x'.repeat(5000))}, nativeDir));
await delay();
assert(errors.some(error => error.includes('size limit')), 'Oversized entry must be rejected without truncation.');
monitor.stop();
monitor.start();
selection.emit(createSelectionSource({'text/plain': encoder.encode('resumed')}, nativeDir));
await delay();
assert(captures.at(-1).text === 'resumed', 'Stop/start must retain recording callbacks.');
monitor.stop();
assert(selection.callback === null, 'Stop must disconnect owner-change monitoring.');
assert(selection.owner !== null, 'Disable must preserve a native clipboard owner.');
print(`Clipboard/native tests passed (${assertions} assertions).`);
