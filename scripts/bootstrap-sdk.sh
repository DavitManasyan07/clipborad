#!/usr/bin/env bash
# Download/extract development files only; never installs system packages.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if (($# > 1)); then printf 'Usage: %s [SDK_DIRECTORY]\n' "$0" >&2; exit 2; fi
sdk_base=${1:-"$root/build/sdk"}
for tool in apt-get dpkg dpkg-deb cc; do
    command -v "$tool" >/dev/null || { printf 'Missing command: %s\n' "$tool" >&2; exit 1; }
done
if [[ $(dpkg --print-architecture) != amd64 ]]; then
    printf 'This extracted SDK path currently supports Ubuntu 24.04 amd64. Use system development packages on other architectures.\n' >&2
    exit 1
fi
mkdir -p -- "$sdk_base/packages" "$sdk_base/root"
sdk_base=$(cd -- "$sdk_base" && pwd)
# These are headers, pkgconf and the GIR compiler used by build-native.sh.
# apt-get download resolves the current versions from the configured Ubuntu APT
# repositories; it does not run dpkg installation or maintainer scripts.
packages=(
    libmutter-14-dev libgirepository1.0-dev libglib2.0-dev
    gir1.2-glib-2.0-dev gir1.2-freedesktop-dev gobject-introspection
    pkgconf-bin libpkgconf3 gsettings-desktop-schemas-dev
    libatk1.0-dev libcairo2-dev libdrm-dev libegl-dev libgl-dev libglx-dev
    libgbm-dev libgdk-pixbuf-2.0-dev libgles-dev libgraphene-1.0-dev libinput-dev
    libpango1.0-dev libwayland-dev libx11-dev libxcomposite-dev libxdamage-dev
    libxext-dev libxfixes-dev libxi-dev libxrandr-dev libharfbuzz-dev libfribidi-dev
    libfontconfig-dev libfreetype-dev libpixman-1-dev libpng-dev libxcb1-dev
    libxcb-render0-dev libxcb-shm0-dev libxrender-dev libxau-dev libxdmcp-dev
    xorg-sgml-doctools x11proto-dev libdatrie-dev libthai-dev libffi-dev libpcre2-dev
    zlib1g-dev libbrotli-dev libmount-dev libselinux1-dev libgraphite2-dev
    libblkid-dev libsepol-dev libexpat1-dev libxft-dev
)
(
    cd -- "$sdk_base/packages"
    apt-get download "${packages[@]}"
)
for package in "$sdk_base/packages"/*.deb; do
    dpkg-deb -x "$package" "$sdk_base/root"
done
printf '\nSDK ready. Build and install with:\nCLIPSHELF_SDK_DIR=%q ./scripts/install.sh\n' "$sdk_base/root"
printf 'Or run checks with:\nCLIPSHELF_SDK_DIR=%q ./scripts/test.sh\n' "$sdk_base/root"
