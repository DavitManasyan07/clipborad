#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$root"
for script in scripts/*.sh; do bash -n "$script"; done
glib-compile-schemas --strict --dry-run schemas
./scripts/build-native.sh
multiarch=$(cc -dumpmachine)
export GI_TYPELIB_PATH="/usr/lib/$multiarch/mutter-14${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
for test_file in tests/*.test.js; do gjs -m "$test_file"; done
printf 'Headless source, storage and native checks passed. Desktop paste/login tests remain separate.\n'
