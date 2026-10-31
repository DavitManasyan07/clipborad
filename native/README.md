# GNOME 46 multi-format clipboard bridge

ClipShelf's interface, capture logic and history store use modern GJS modules. This
small C library supplies only a `MetaSelectionSource` subclass that advertises a
set of MIME types and returns an independent `GMemoryInputStream` of the exact
stored bytes for each requested format. All representations belong to one owner;
restoring HTML and plain text, or Nautilus file-copy formats, does not replace the
previous MIME representation with a later clipboard write.

The local GJS 1.80.2 rejects a JavaScript override of `MetaSelectionSource.read_async`:
`VFunc read_async accepts another callback as a parameter. This is not supported`.
Mutter 46's `MetaSelectionSourceMemory` advertises only one MIME type. The bridge
implements the necessary async vfunc in C and exposes a constructor and `add()`
method through the handwritten `ClipShelf-1.0.gir` introspection description.
There is no clipboard subprocess, polling loop, external service, GTK focus
requirement, image conversion, or disk I/O in this native component.

The source matches the installed **Mutter 46 / Meta 14 ABI**. Compilation uses the
actual Mutter development headers. GNOME major versions beyond 46 are not claimed
supported. Native types remain loaded until GNOME Shell exits; updating the native
library therefore requires a new login to reliably use the new implementation.
The source can safely keep serving an already restored clipboard after extension
disable because no native async callback calls back into extension JavaScript.

Build from the repository root:

```bash
sudo apt install build-essential pkg-config libmutter-14-dev libgirepository1.0-dev
./scripts/build-native.sh
```

The output is `build/native/libclipshelf-1.so` and
`build/native/ClipShelf-1.0.typelib`. The installer copies these to the extension's
`native/` directory. The GJS loader prepends that directory to GI's typelib and
library paths. No global loader configuration is changed.

Compilation uses `-shared -fPIC -O2 -Wall -Wextra -Werror` and a local soname,
with `pkg-config --cflags libmutter-14 gio-2.0`. Only Gio, GObject, GLib and Mutter
symbols are linked. The GIR compiler reads the installed Meta 14 GIR dependencies.

For an Ubuntu 24.04 amd64 host where a C compiler is available but sudo is not,
development packages can instead be downloaded and extracted without installation:

```bash
./scripts/bootstrap-sdk.sh
CLIPSHELF_SDK_DIR="$PWD/build/sdk/root" ./scripts/test.sh
CLIPSHELF_SDK_DIR="$PWD/build/sdk/root" ./scripts/install.sh
```

An existing extracted SDK can be selected with `CLIPSHELF_SDK_DIR`. For example,
the development run used `/tmp/clipshelf-sdk/root`. Its compiler headers and GIR
metadata are used with the host's installed GNOME 46 runtime libraries. The SDK
path is needed only for building; it is not referenced by the installed extension.
`CLIPSHELF_BUILD_DIR` optionally changes the artifact output directory.

The source repository includes no copied GNOME dependency headers or binaries.
Build outputs and downloaded SDK packages are ignored by Git. The native tests
instantiate the actual subclass and verify multiple advertised MIME formats,
exact binary streams, concurrent reads, unsupported-format errors, and ownership
handling. These tests do not claim application paste or Wayland session proof.

Primary references checked against the local headers and typelibs:

- [Mutter 46.2 selection-source API](https://github.com/GNOME/mutter/blob/46.2/src/meta/meta-selection-source.h)
- [Mutter 46.2 selection ownership and transfers](https://github.com/GNOME/mutter/blob/46.2/src/core/meta-selection.c)
- [Mutter 46.0 single-format memory source](https://github.com/GNOME/mutter/blob/46.0/src/core/meta-selection-source-memory.c)
