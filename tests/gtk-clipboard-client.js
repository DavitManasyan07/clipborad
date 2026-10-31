/* A real Wayland client used only by the isolated compositor smoke test. */
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const [mode, directory, extensionPath] = ARGV;
if (!GLib.getenv('CLIPSHELF_ISOLATED_SMOKE') || !mode || !directory)
    throw new Error('This fixture requires the isolated smoke-test environment.');
const resultPath = GLib.build_filenamev([directory, `${mode}.json`]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const [, configBytes] = GLib.file_get_contents(GLib.build_filenamev([directory, 'client-config.json']));
const config = JSON.parse(decoder.decode(configBytes));
let app;
let done = false;
let provider = null;
let assertions = 0;

function assert(condition, message) {
    assertions++;
    if (!condition)
        throw new Error(message);
}

function finish(result, quit = true) {
    if (done)
        return;
    GLib.file_set_contents(resultPath, JSON.stringify({...result, assertions}));
    if (quit) {
        done = true;
        app.quit();
    }
}

async function readBytes(clipboard, mime) {
    const [stream, actualMime] = await new Promise((resolve, reject) => {
        clipboard.read_async([mime], GLib.PRIORITY_DEFAULT, null, (object, result) => {
            try { resolve(object.read_finish(result)); }
            catch (error) { reject(error); }
        });
    });
    assert(actualMime === mime, 'Consumer must receive the requested MIME representation.');
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const bytes = await new Promise((resolve, reject) => {
                stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, null, (input, result) => {
                    try { resolve(input.read_bytes_finish(result).toArray()); }
                    catch (error) { reject(error); }
                });
            });
            if (!bytes.length)
                break;
            chunks.push(bytes);
            length += bytes.length;
            assert(length < 1024 * 1024, 'Synthetic fixture payload must stay bounded.');
        }
    } finally {
        stream.close(null);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const bytes of chunks) {
        output.set(bytes, offset);
        offset += bytes.length;
    }
    return output;
}

async function work(window) {
    const clipboard = Gdk.Display.get_default().get_clipboard();
    assert(Gdk.Display.get_default().get_name() === GLib.getenv('CLIPSHELF_TEST_WAYLAND_DISPLAY'),
        'Fixture must connect to the private Wayland compositor.');
    if (mode === 'offer-rich' || mode === 'offer-files') {
        const [, png] = GLib.file_get_contents(config.pngPath);
        const representations = mode === 'offer-rich' ? {
            'text/plain': encoder.encode(config.text),
            'text/html': encoder.encode(config.html),
            'image/png': png,
        } : {
            'x-special/gnome-copied-files': encoder.encode(`cut\n${config.uris.join('\n')}`),
            'text/uri-list': encoder.encode(`${config.uris.join('\r\n')}\r\n`),
        };
        provider = Gdk.ContentProvider.new_union(Object.entries(representations).map(([mime, bytes]) =>
            Gdk.ContentProvider.new_for_bytes(mime, new GLib.Bytes(bytes))));
        assert(clipboard.set_content(provider), 'GTK provider must own the clipboard.');
        finish({ok: true, offered: Object.keys(representations)}, false);
        return;
    }
    if (mode === 'read-rich') {
        const text = await readBytes(clipboard, 'text/plain');
        assert(decoder.decode(text) === config.text, 'A new GTK application must paste exact Unicode text.');
        const html = await readBytes(clipboard, 'text/html');
        assert(decoder.decode(html) === config.html, 'A new GTK application must paste exact HTML bytes.');
        const png = await readBytes(clipboard, 'image/png');
        const [, expected] = GLib.file_get_contents(config.pngPath);
        assert(png.length === expected.length && png.every((byte, index) => byte === expected[index]),
            'A new GTK application must paste the original PNG binary.');
        const texture = await new Promise((resolve, reject) => {
            clipboard.read_texture_async(null, (object, result) => {
                try { resolve(object.read_texture_finish(result)); }
                catch (error) { reject(error); }
            });
        });
        assert(texture.get_width() === 120 && texture.get_height() === 80,
            'GTK must decode restored clipboard data as an actual image texture.');
        finish({ok: true, pasted: ['text/plain', 'text/html', 'image/png'], texture: [120, 80]});
        return;
    }
    if (mode === 'read-files') {
        const copy = decoder.decode(await readBytes(clipboard, 'x-special/gnome-copied-files'));
        assert(copy === `copy\n${config.uris.join('\n')}`, 'New GTK client must read normalized copy semantics.');
        const uriList = decoder.decode(await readBytes(clipboard, 'text/uri-list'));
        assert(uriList === `${config.uris.join('\r\n')}\r\n`, 'New GTK client must read every original file reference.');
        finish({ok: true, pasted: ['x-special/gnome-copied-files', 'text/uri-list']});
        return;
    }
    if (mode === 'prefs') {
        Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
        Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/gnome-shell-dbus-interfaces.gresource'));
        const {default: Preferences} = await import(Gio.File.new_for_path(`${extensionPath}/prefs.js`).get_uri());
        const [, metadataBytes] = GLib.file_get_contents(`${extensionPath}/metadata.json`);
        const metadata = {...JSON.parse(decoder.decode(metadataBytes)), path: extensionPath,
            dir: Gio.File.new_for_path(extensionPath)};
        const preferences = new Preferences(metadata);
        const preferencesWindow = new Adw.PreferencesWindow({application: app});
        preferences.fillPreferencesWindow(preferencesWindow);
        preferencesWindow.present();
        assert(preferencesWindow.get_visible_page() !== null, 'Actual Adw preferences page must be populated.');
        assert(preferencesWindow._clipshelfSettings.get_int('max-items') === 100,
            'Preferences must load the installed extension settings schema.');
        assert(preferencesWindow._clipshelfSettings.settings_schema.has_key('toggle-clipshelf'),
            'Preferences must use the unique ClipShelf shortcut schema.');
        finish({ok: true, preferences: true});
        return;
    }
    throw new Error('Unknown fixture mode.');
}

app = new Gtk.Application({application_id: 'org.example.ClipShelfSmoke',
    flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({application: app,
        title: `ClipShelf GTK fixture ${mode}`, default_width: 360, default_height: 160});
    window.set_child(new Gtk.Label({label: 'Synthetic clipboard integration fixture'}));
    window.present();
    const start = GLib.get_monotonic_time();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        try {
            if (!window.is_active && GLib.get_monotonic_time() - start < 5000000)
                return GLib.SOURCE_CONTINUE;
            work(window).catch(error => finish({ok: false, error: error.message}));
        } catch (error) {
            finish({ok: false, error: error.message});
        }
        return GLib.SOURCE_REMOVE;
    });
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () => {
    finish({ok: false, error: 'GTK clipboard fixture timed out.'});
    return GLib.SOURCE_REMOVE;
});
app.run([]);
