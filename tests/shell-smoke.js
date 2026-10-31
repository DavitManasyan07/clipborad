/* Loaded only into a disposable extension copy by scripts/test-shell.sh. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {createSelectionSource} from './src/clipboard.js';

const UUID = 'clipshelf@local.davit';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let assertions = 0;
const checks = [];
const children = new Set();
const inputDiagnostics = [];
const setup = [];
const virtualKeys = GLib.getenv('CLIPSHELF_SMOKE_VIRTUAL_KEYS') === '1';

function assert(value, message) {
    assertions++;
    if (!value)
        throw new Error(message);
}

function delay(ms = 50) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function until(test, message, timeout = 12000) {
    const start = GLib.get_monotonic_time();
    while (!test()) {
        if ((GLib.get_monotonic_time() - start) / 1000 > timeout)
            throw new Error(message);
        await delay();
    }
}

async function transfer(selection, mime) {
    const output = Gio.MemoryOutputStream.new_resizable();
    await new Promise((resolve, reject) => {
        selection.transfer_async(Meta.SelectionType.SELECTION_CLIPBOARD,
            mime, -1, output, null, (owner, result) => {
                try { owner.transfer_finish(result); resolve(); }
                catch (error) { reject(error); }
            });
    });
    output.close(null);
    return output.steal_as_bytes().toArray();
}

async function screenshot(path) {
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    const shooter = new Shell.Screenshot();
    try {
        await new Promise((resolve, reject) => {
            shooter.screenshot(false, stream, (object, result) => {
                try { object.screenshot_finish(result); resolve(); }
                catch (error) { reject(error); }
            });
        });
    } finally {
        stream.close(null);
    }
}

async function gtkClient(extension, mode, directory) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE});
    launcher.set_stderr_file_path(`${directory}/${mode}.log`);
    launcher.setenv('WAYLAND_DISPLAY', GLib.getenv('CLIPSHELF_TEST_WAYLAND_DISPLAY'), true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    launcher.setenv('GI_TYPELIB_PATH', '/usr/lib/gnome-shell/girepository-1.0', true);
    launcher.setenv('LD_LIBRARY_PATH', '/usr/lib/gnome-shell', true);
    const child = launcher.spawnv(['gjs', '-m', `${extension.path}/gtk-clipboard-client.js`,
        mode, directory, extension.path]);
    children.add(child);
    const resultPath = GLib.build_filenamev([directory, `${mode}.json`]);
    await until(() => GLib.file_test(resultPath, GLib.FileTest.EXISTS),
        `GTK ${mode} did not produce a result.`, 15000);
    const [, bytes] = GLib.file_get_contents(resultPath);
    const result = JSON.parse(decoder.decode(bytes));
    assert(result.ok, `GTK ${mode} failed: ${result.error ?? 'unknown error'}`);
    assertions += result.assertions;
    return child;
}

async function closeChild(child) {
    child.force_exit();
    await new Promise(resolve => child.wait_async(null, () => resolve()));
    children.delete(child);
}

async function test() {
    await until(() => Main.extensionManager.lookup(UUID)?.stateObj?._monitor,
        'Extension did not initialize in the isolated Shell.');
    let extension = Main.extensionManager.lookup(UUID).stateObj;
    const selection = global.display.get_selection();
    const nativeDir = GLib.build_filenamev([extension.path, 'native']);
    const keyboard = virtualKeys ? Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE) : null;
    global.stage.connect('captured-event', (_stage, event) => {
        if (event.type() === Clutter.EventType.KEY_PRESS || event.type() === Clutter.EventType.KEY_RELEASE) {
            inputDiagnostics.push({event: event.type(), key: event.get_key_symbol(),
                focus: global.stage.get_key_focus()?.constructor.name ?? null,
                searchFocus: global.stage.get_key_focus() === extension._indicator?._search?.clutter_text,
                menuOpen: extension._indicator?.menu.isOpen ?? false,
                startingUp: Main.layoutManager._startingUp, modalCount: Main.modalCount});
        }
        return Clutter.EVENT_PROPAGATE;
    });
    const key = async symbol => {
        if (!virtualKeys) {
            if (symbol === Clutter.KEY_Shift_L)
                return;
            // Deterministic handler coverage: native event delivery is a separate
            // opt-in check because a headless virtual seat can drop input. Search
            // focus on opening is asserted independently without manual focus.
            if (symbol === Clutter.KEY_Return)
                global.stage.set_key_focus(extension._indicator._search.clutter_text);
            extension._indicator._keyEvent({type: () => Clutter.EventType.KEY_PRESS,
                get_key_symbol: () => symbol});
            await delay(100);
            return;
        }
        const time = GLib.get_monotonic_time();
        keyboard.notify_keyval(time, symbol, Clutter.KeyState.PRESSED);
        await delay(40);
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
        await delay(100);
    };
    const publish = representations => {
        const source = createSelectionSource(representations, nativeDir);
        selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
        return source;
    };
    // With no physical display GNOME46 can leave its startup animation waiting
    // for allocation/frame-clock work. This suite tests post-login behavior.
    // Make the fixture's finalizer idempotent in case the late animation callback
    // also runs; no installed ClipShelf source or user Shell is changed.
    await until(() => Main.overview.visible || !Main.layoutManager._startingUp,
        'GNOME startup overview did not initialize.', 15000);
    const layout = Main.layoutManager;
    const completeStartup = layout._startupAnimationComplete;
    layout._startupAnimationComplete = function () {
        if (this._startingUp)
            completeStartup.call(this);
    };
    await delay(1000);
    if (layout._startingUp) {
        layout._startupAnimationComplete();
        setup.push('GNOME46 headless startup finalized through its installed layout method; actual login remains manual.');
    }
    Main.overview.hide();
    await until(() => !Main.layoutManager._startingUp, 'GNOME startup did not finish.', 15000);
    await until(() => !Main.overview.visible && !Main.overview.animationInProgress,
        'GNOME overview did not settle before input testing.');
    await key(Clutter.KEY_Shift_L);
    assert(Boolean(Main.panel.statusArea[UUID]), 'Panel indicator must be registered.');
    checks.push('native extension enable / panel creation');

    const unicode = 'Բարև աշխարհ\nconst answer = 42;';
    const rich = {
        'text/plain': encoder.encode(unicode),
        'text/html': encoder.encode('<p><b>ClipShelf test</b></p>'),
    };
    publish(rich);
    await until(() => extension._store.items.some(item => item.text === unicode),
        'Real selection owner change did not enter history.');
    let entry = extension._store.items.find(item => item.text === unicode);
    assert(entry.representations['text/html'] !== undefined, 'HTML representation must be retained.');
    const originalCount = extension._store.items.length;
    extension._indicator.menu.open();
    await until(() => global.stage.get_key_focus() === extension._indicator._search.clutter_text &&
        extension._indicator.menu.actor.mapped, 'Opening the popup must automatically focus its search field.');
    assert(global.stage.get_key_focus() === extension._indicator._search.clutter_text,
        'Popup must focus search after GNOME installs its modal grab.');
    assert(extension._indicator.menu.isOpen, 'Popup must open.');
    assert(extension._indicator._rows.length === originalCount, 'Popup must render history rows.');
    extension._indicator._search.set_text('answer');
    await delay();
    assert(extension._indicator._rows.length === 1, 'Search must filter history.');
    extension._indicator._search.set_text('');
    await until(() => global.stage.get_key_focus() === extension._indicator._search.clutter_text &&
        extension._indicator.menu.actor.mapped, 'Popup search must own keyboard focus before input.');
    await key(Clutter.KEY_Down);
    await until(() => extension._indicator._selected === 0,
        'Down input must reach the focused popup.', 2000);
    assert(extension._indicator._selected === 0, 'Down handling must select a history row.');
    await key(Clutter.KEY_Return);
    await until(() => !extension._indicator.menu.isOpen, 'Enter handling must restore and close the popup.');
    assert(!extension._indicator.menu.isOpen, 'Restoring must close the popup.');
    assert(selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD).includes('text/html'),
        'Restored clipboard must advertise HTML together with plain text.');
    assert(decoder.decode(await transfer(selection, 'text/plain')) === unicode,
        'Mutter transfer must restore exact Unicode/multiline bytes.');
    assert(decoder.decode(await transfer(selection, 'text/html')) === '<p><b>ClipShelf test</b></p>',
        'Mutter transfer must restore exact HTML bytes.');
    await delay(150);
    assert(extension._store.items.length === originalCount, 'Restore must not capture itself.');
    extension._indicator.menu.open();
    await until(() => global.stage.get_key_focus() === extension._indicator._search.clutter_text,
        'Reopening the popup must automatically focus search.');
    await key(Clutter.KEY_Escape);
    await until(() => !extension._indicator.menu.isOpen, 'Escape must reach the focused popup.', 2000);
    assert(!extension._indicator.menu.isOpen, 'Escape handling must close the popup.');
    checks.push(`Wayland Mutter selection capture / Unicode / HTML / search / ${virtualKeys ?
        'virtual-keyboard Down+Enter+Escape events' :
        'direct Down+Enter+Escape handler coverage (desktop input delivery remains manual)'} / restore / no loop`);

    publish(rich);
    await delay(300);
    assert(extension._store.items.length === originalCount, 'Duplicate clipboard data must deduplicate.');
    extension._settings.set_boolean('paused', true);
    publish({'text/plain': encoder.encode('paused synthetic clipboard')});
    await delay(150);
    assert(extension._store.items.length === originalCount, 'Pause must suppress recording.');
    extension._settings.set_boolean('paused', false);
    publish({'text/plain': encoder.encode('resumed synthetic clipboard')});
    await until(() => extension._store.items.some(item => item.text === 'resumed synthetic clipboard'),
        'Resume must restore recording callbacks.');
    checks.push('deduplication / pause / resume');

    const fileA = GLib.build_filenamev([GLib.get_user_data_dir(), 'smoke-file-a.txt']);
    const fileB = GLib.build_filenamev([GLib.get_user_data_dir(), 'smoke-file-b.txt']);
    GLib.file_set_contents(fileA, 'synthetic test A');
    GLib.file_set_contents(fileB, 'synthetic test B');
    const uris = [Gio.File.new_for_path(fileA).get_uri(), Gio.File.new_for_path(fileB).get_uri()];
    publish({'x-special/gnome-copied-files': encoder.encode(`cut\n${uris.join('\n')}`)});
    await until(() => extension._store.items.some(item => item.kind === 'files'),
        'Nautilus multiple-file data must be captured.');
    const files = extension._store.items.find(item => item.kind === 'files');
    assert(files.files.length === 2, 'Both file references must be retained.');
    assert((await extension._store.checkFiles(files)).available, 'Test file references must be available.');
    await extension.restore(files);
    assert(decoder.decode(await transfer(selection, 'x-special/gnome-copied-files')).startsWith('copy\n'),
        'Historical cut must restore copy semantics.');
    assert(decoder.decode(await transfer(selection, 'text/uri-list')) === `${uris.join('\r\n')}\r\n`,
        'File URI list must restore all references.');
    checks.push('real file references / multi-file copy MIME / cut normalization');

    // A visible synthetic raster exercises storage, real thumbnails and restore.
    const pngPath = GLib.build_filenamev([GLib.get_user_data_dir(), 'smoke-image.png']);
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 120, 80);
    const context = new Cairo.Context(surface);
    context.setSourceRGB(0.35, 0.25, 0.65);
    context.paint();
    context.setSourceRGB(0.95, 0.70, 0.30);
    context.rectangle(12, 12, 44, 56);
    context.fill();
    context.setSourceRGB(0.30, 0.80, 0.75);
    context.arc(85, 40, 23, 0, Math.PI * 2);
    context.fill();
    surface.writeToPNG(pngPath);
    context.$dispose();
    const [, png] = GLib.file_get_contents(pngPath);
    publish({'image/png': png});
    await until(() => extension._store.items.some(item => item.kind === 'image'),
        'PNG clipboard bytes must be captured.');
    const image = extension._store.items.find(item => item.kind === 'image');
    await extension.restore(image);
    const restoredPng = await transfer(selection, 'image/png');
    assert(restoredPng.length === png.length && restoredPng.every((value, index) => value === png[index]),
        'Restored PNG must match the original binary image.');
    extension._indicator.menu.open();
    await until(() => extension._indicator._rows.find(row => row.item.id === image.id)
        ?.select.child.get_first_child()?.child?.get_content(),
    'Image row must load a real thumbnail texture.');
    const screenshotPath = GLib.getenv('CLIPSHELF_SMOKE_SCREENSHOT');
    if (screenshotPath)
        await screenshot(screenshotPath);
    extension._indicator.menu.close();
    checks.push('binary PNG capture / thumbnail rendering / MIME restore');

    const clientDirectory = GLib.build_filenamev([GLib.get_user_data_dir(), 'gtk-client']);
    GLib.mkdir_with_parents(clientDirectory, 0o700);
    const clientConfig = {text: 'GTK application Բարև\nsecond line',
        html: '<p><b>GTK application Բարև</b></p>', pngPath, uris};
    GLib.file_set_contents(`${clientDirectory}/client-config.json`, JSON.stringify(clientConfig));
    const provider = await gtkClient(extension, 'offer-rich', clientDirectory);
    await until(() => extension._store.items.some(item => item.text === clientConfig.text),
        'A separate GTK Wayland application must enter history while popup is closed.');
    const appImage = extension._store.items.find(item => item.text === clientConfig.text);
    assert(!extension._indicator.menu.isOpen, 'Background GTK capture must not require an open popup.');
    await closeChild(provider);
    await delay(100);
    await extension.restore(appImage);
    const consumer = await gtkClient(extension, 'read-rich', clientDirectory);
    await closeChild(consumer);
    checks.push('external GTK Wayland provider closes / new client pastes exact text + HTML + PNG / image decode');

    const fileProvider = await gtkClient(extension, 'offer-files', clientDirectory);
    await until(() => extension._store.items[0]?.kind === 'files',
        'A separate GTK file-copy provider must enter history.');
    const appFiles = extension._store.items[0];
    await closeChild(fileProvider);
    await extension.restore(appFiles);
    const fileConsumer = await gtkClient(extension, 'read-files', clientDirectory);
    await closeChild(fileConsumer);
    checks.push('external GTK file MIME provider / provider exit / consumer reads copy + URI-list formats');
    const prefs = await gtkClient(extension, 'prefs', clientDirectory);
    await closeChild(prefs);
    checks.push('actual GTK4/libadwaita preferences page creation / installed settings binding');

    extension._indicator.menu.open();
    await delay(250);
    for (const kind of ['text', 'image', 'files']) {
        extension._indicator._filters.find(([value]) => value === kind)[1].emit('clicked', 1);
        assert(extension._indicator._rows.length > 0 &&
            extension._indicator._rows.every(row => row.item.kind === kind),
        `The ${kind} filter must render only matching entries.`);
    }
    await extension._store.togglePin(appImage.id);
    extension._indicator._filters.find(([value]) => value === 'pinned')[1].emit('clicked', 1);
    assert(extension._indicator._rows.length === 1 && extension._indicator._rows[0].item.id === appImage.id,
        'The pinned filter must show the pinned entry.');
    await extension._store.togglePin(appImage.id);
    extension._indicator._filters.find(([value]) => value === 'all')[1].emit('clicked', 1);
    checks.push('text / image / files / pinned filters in actual popup');
    await until(() => extension._indicator._rows.filter(row => row.item.kind === 'image')
        .every(row => row.select.child.get_first_child()?.child?.get_content()),
    'Displayed image rows must finish loading their thumbnail textures.');
    await delay(200);
    if (screenshotPath)
        await screenshot(screenshotPath);
    extension._interfaceSettings.set_string('color-scheme', 'prefer-light');
    await delay(200);
    if (screenshotPath)
        await screenshot(screenshotPath.replace(/\.png$/u, '-light.png'));
    extension._interfaceSettings.set_string('color-scheme', 'prefer-dark');
    extension._indicator.menu.close();

    const preservedCount = extension._store.items.length;
    await extension._store.flush();
    await Main.extensionManager._callExtensionDisable(UUID);
    assert(!Main.panel.statusArea[UUID], 'Disable must remove its panel indicator.');
    assert(extension._monitor === null && extension._indicator === null,
        'Disable must release monitor and UI references.');
    await Main.extensionManager._callExtensionEnable(UUID);
    extension = Main.extensionManager.lookup(UUID).stateObj;
    await until(() => extension._monitor && extension._store.items.length === preservedCount,
        'Re-enable must load persisted history.');
    assert(Boolean(Main.panel.statusArea[UUID]), 'Re-enable must register exactly one indicator.');
    assert(decoder.decode(await transfer(selection, 'x-special/gnome-copied-files')).startsWith('copy\n'),
        'Native clipboard owner must remain readable across disable/enable.');
    publish({'text/plain': encoder.encode('after re-enable synthetic clipboard')});
    await until(() => extension._store.items.some(item => item.text === 'after re-enable synthetic clipboard'),
        'Re-enabled extension must record new owners.');
    checks.push('disable cleanup / enable / persisted history / continued recording');
    Main.sessionMode.pushMode('unlock-dialog');
    await until(() => extension._indicator === null,
        'Lock-screen session mode must disable the extension interface.');
    assert(!Main.panel.statusArea[UUID], 'Lock-screen mode must remove ClipShelf from the panel.');
    Main.sessionMode.popMode('unlock-dialog');
    await until(() => extension._monitor && extension._indicator,
        'Leaving the lock-screen session mode must re-enable the extension.');
    assert(Boolean(Main.panel.statusArea[UUID]), 'Unlock mode transition must restore the panel indicator.');
    checks.push('simulated lock-screen session-mode disable / unlock re-enable');
    await extension._store.flush();
    return {ok: true, assertions, inputMode: virtualKeys ? 'virtual-keyboard' : 'direct-handler', setup, checks};
}

export function runSmoke() {
    // This test module is injected only into a temporary installation. The guard
    // prevents imported fixtures from ever running against a normal user session.
    const resultPath = GLib.getenv('CLIPSHELF_SMOKE_RESULT');
    if (!resultPath || !GLib.getenv('CLIPSHELF_ISOLATED_SMOKE'))
        return;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        test().then(result => {
            GLib.file_set_contents(resultPath, JSON.stringify(result, null, 2));
            global.context.terminate();
        }).catch(error => {
            GLib.file_set_contents(resultPath, JSON.stringify({ok: false, assertions,
                checks, setup, inputMode: virtualKeys ? 'virtual-keyboard' : 'direct-handler',
                error: error.message, stack: error.stack, inputDiagnostics,
                focus: global.stage.get_key_focus()?.constructor.name ?? null,
                startupComplete: !Main.layoutManager._startingUp,
                modalCount: Main.modalCount}, null, 2));
            for (const child of children)
                child.force_exit();
            global.context.terminate();
        });
        return GLib.SOURCE_REMOVE;
    });
}
