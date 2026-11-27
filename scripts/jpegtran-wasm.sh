#!/bin/sh
# Rebuilds packages/web/src/progressive/jpegtran.wasm from libjpeg-turbo with nix (scripts/jpegtran-wasm.nix), and
# its licence beside it. The test (packages/web/test/progressive.test.ts) checks it writes what native jpegtran does.
set -eu
cd "$(dirname "$0")/.."
out=$(nix-build --no-out-link scripts/jpegtran-wasm.nix)
install -m 644 "$out/jpegtran.wasm" packages/web/src/progressive/jpegtran.wasm
install -m 644 "$out/LICENSE.md" packages/web/src/progressive/LICENSE.libjpeg-turbo.md
install -m 644 "$out/README.ijg" packages/web/src/progressive/README.ijg
echo "jpegtran.wasm: $(wc -c < packages/web/src/progressive/jpegtran.wasm) bytes"
