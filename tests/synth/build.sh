#!/usr/bin/env bash
# Assembles tests/synth/synthrom.s for the ARM9 (ARMv5TE) and prints the machine-code words for tests/lib/synth-rom.mjs.
# Needs llvm-mc and ld.lld built with the ARM target (system LLVM; emsdk's LLVM is wasm-only).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
tmp="$(mktemp -d)"
llvm-mc -triple=armv5te -filetype=obj synthrom.s -o "$tmp/a.o"
ld.lld -Ttext=0x02000004 -e _start --oformat=binary "$tmp/a.o" -o "$tmp/a.bin"
python3 -I -c "
import sys
d = open(sys.argv[1], 'rb').read()
print(', '.join('0x%08x' % int.from_bytes(d[i:i+4], 'little') for i in range(0, len(d), 4)))" "$tmp/a.bin"
rm -rf "$tmp"
