#!/usr/bin/env python3
"""Builds tests/artifacts/integration.nds (arm-none-eabi-gcc, apt: gcc-arm-none-eabi). CC0, nothing from Nintendo.
Header trick copied from tests/lib/synth-rom.mjs (Phase 6): game code ZZZE (not in melonDS's database => retail cart with the default
8 KiB EEPROM), ARM9 offset >= 0x8000 and the 0xE7FFDEFF 'decrypted secure area' marker word before the ARM9 code, logo CRC field 0xCF56."""
import struct, subprocess, sys, pathlib
here = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else here / "integration.nds")
build = here / "build"; build.mkdir(exist_ok=True)

def build_cpu(name, cpu):
    elf = build / f"{name}.elf"; binf = build / f"{name}.bin"
    subprocess.check_call(["arm-none-eabi-gcc", f"-mcpu={cpu}", "-marm", "-O2", "-nostdlib", "-ffreestanding", "-Wall",
                           "-T", str(here / f"{name}.ld"), str(here / "crt0.s"), str(here / f"{name}.c"), "-o", str(elf)])
    subprocess.check_call(["arm-none-eabi-objcopy", "-O", "binary", str(elf), str(binf)])
    return binf.read_bytes()

arm9 = struct.pack("<I", 0xE7FFDEFF) + build_cpu("arm9", "arm946e-s"); arm7 = build_cpu("arm7", "arm7tdmi")
pad = lambda b, n: b + b"\0" * (-len(b) % n)
ARM9_OFF = 0x8000; ARM7_OFF = ARM9_OFF + len(pad(arm9, 0x200))
total = ARM7_OFF + len(pad(arm7, 0x200))
h = bytearray(0x4000)
h[0:12] = b"MDSINTEGRATE"; h[12:16] = b"ZZZE"; h[16:18] = b"00"
struct.pack_into("<IIII", h, 0x20, ARM9_OFF, 0x02000004, 0x02000000, len(arm9))
struct.pack_into("<IIII", h, 0x30, ARM7_OFF, 0x02380000, 0x02380000, len(arm7))
struct.pack_into("<I", h, 0x80, total); struct.pack_into("<I", h, 0x84, 0x4000)
struct.pack_into("<H", h, 0x15C, 0xCF56)
rom = bytes(h) + b"\0" * (ARM9_OFF - len(h)) + pad(arm9, 0x200) + pad(arm7, 0x200)
rom += b"\0" * (-len(rom) % 0x20000)
out.write_bytes(rom)
print(f"wrote {out} ({len(rom)} bytes)")
