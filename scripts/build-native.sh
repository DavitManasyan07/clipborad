#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
build_dir=${CLIPSHELF_BUILD_DIR:-"$root/build/native"}
pkg_config=pkg-config
gir_compiler=g-ir-compiler
sdk_dir=${CLIPSHELF_SDK_DIR:-}
if [[ -z "$sdk_dir" && -d "$root/build/sdk/root" ]] &&
    { ! command -v pkg-config >/dev/null || ! pkg-config --exists libmutter-14 gio-2.0; }; then
    sdk_dir="$root/build/sdk/root"
fi
if [[ -n "$sdk_dir" ]]; then
    sdk_dir=$(cd -- "$sdk_dir" && pwd)
    pkg_config="$sdk_dir/usr/bin/pkgconf"
    gir_compiler="$sdk_dir/usr/lib/x86_64-linux-gnu/gobject-introspection/g-ir-compiler"
    export LD_LIBRARY_PATH="$sdk_dir/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export PKG_CONFIG_SYSROOT_DIR="$sdk_dir"
    export PKG_CONFIG_LIBDIR="$sdk_dir/usr/lib/x86_64-linux-gnu/pkgconfig:$sdk_dir/usr/share/pkgconfig"
fi
for tool in cc "$pkg_config" "$gir_compiler"; do
    if ! command -v "$tool" >/dev/null; then
        printf 'Missing build tool: %s. Install libmutter-14-dev libgirepository1.0-dev libglib2.0-dev pkg-config.\n' "$tool" >&2
        exit 1
    fi
done
if ! "$pkg_config" --exists libmutter-14 gio-2.0; then
    printf 'Missing GNOME 46 development libraries. Install libmutter-14-dev libgirepository1.0-dev libglib2.0-dev pkg-config.\n' >&2
    exit 1
fi
mkdir -p -- "$build_dir"
exec 8>"$build_dir/.build.lock"
flock 8
stage=$(mktemp -d "$build_dir/.build.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
# pkg-config intentionally emits a compiler argument list, never user content.
read -r -a cflags <<< "$("$pkg_config" --cflags libmutter-14 gio-2.0)"
if [[ -n "$sdk_dir" ]]; then
    # Extracted SDK headers use the host's already installed GNOME 46 runtime.
    libs=(-l:libmutter-14.so.0 -l:libgio-2.0.so.0 -l:libgobject-2.0.so.0 -l:libglib-2.0.so.0)
else
    read -r -a libs <<< "$("$pkg_config" --libs gio-2.0) -lmutter-14"
fi
cc -shared -fPIC -O2 -Wall -Wextra -Werror -Wl,-soname,libclipshelf-1.so \
    "${cflags[@]}" "$root/native/clip-shelf-source.c" "${libs[@]}" \
    -o "$stage/libclipshelf-1.so"
gir_dir=$("$pkg_config" --variable=girdir libmutter-14)
if [[ -n "$sdk_dir" ]]; then
    if [[ "$gir_dir" != "$sdk_dir"/* ]]; then gir_dir="$sdk_dir$gir_dir"; fi
    "$gir_compiler" --includedir="$gir_dir" --includedir="$sdk_dir/usr/share/gir-1.0" \
        "$root/native/ClipShelf-1.0.gir" -o "$stage/ClipShelf-1.0.typelib"
else
    "$gir_compiler" --includedir="$gir_dir" "$root/native/ClipShelf-1.0.gir" \
        -o "$stage/ClipShelf-1.0.typelib"
fi
mv -f -- "$stage/libclipshelf-1.so" "$stage/ClipShelf-1.0.typelib" "$build_dir/"
printf 'Built GNOME 46 multi-format clipboard bridge in %s\n' "$build_dir"
