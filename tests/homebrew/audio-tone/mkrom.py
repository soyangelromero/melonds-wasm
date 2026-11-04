#!/usr/bin/env python3
"""Builds audio-tone.nds from arm7.c / arm9.c with arm-none-eabi-gcc (apt: gcc-arm-none-eabi). CC0.
The header has NO Nintendo logo (it is Nintendo artwork; melonDS accepts ARM9 offset < 0x4000 as homebrew and skips the logo CRC check)."""
import math, struct, subprocess, sys, pathlib

here = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else here / "audio-tone.nds")
build = here / "build"; build.mkdir(exist_ok=True)

(here / "sine.h").write_text("static const int16_t sine64[64] = {" + ",".join(
    str(round(16000 * math.sin(2 * math.pi * i / 64))) for i in range(64)) + "};\n")

def build_cpu(name, cpu):
    elf = build / f"{name}.elf"; binf = build / f"{name}.bin"
    subprocess.check_call(["arm-none-eabi-gcc", f"-mcpu={cpu}", "-marm", "-O2", "-nostdlib", "-ffreestanding", "-Wall",
                           "-T", str(here / f"{name}.ld"), str(here / "crt0.s"), str(here / f"{name}.c"), "-o", str(elf)])
    subprocess.check_call(["arm-none-eabi-objcopy", "-O", "binary", str(elf), str(binf)])
    return binf.read_bytes()

arm9 = build_cpu("arm9", "arm946e-s"); arm7 = build_cpu("arm7", "arm7tdmi")
pad = lambda b, n: b + b"\0" * (-len(b) % n)
ARM9_OFF = 0x200; ARM7_OFF = ARM9_OFF + len(pad(arm9, 0x200))
total = ARM7_OFF + len(pad(arm7, 0x200))

def crc16(data, crc=0xFFFF):
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

h = bytearray(0x200)
h[0:12] = b"MDSAUDIOTONE"; h[12:16] = b"MDST"; h[16:18] = b"00"
struct.pack_into("<IIII", h, 0x20, ARM9_OFF, 0x02000000, 0x02000000, len(arm9))
struct.pack_into("<IIII", h, 0x30, ARM7_OFF, 0x02380000, 0x02380000, len(arm7))
struct.pack_into("<I", h, 0x80, total)       # total used ROM size
struct.pack_into("<I", h, 0x84, 0x200)       # header size
struct.pack_into("<H", h, 0x15E, crc16(h[:0x15E]))
rom = bytes(h) + pad(arm9, 0x200) + pad(arm7, 0x200)
rom += b"\0" * (-len(rom) % 0x20000) if len(rom) % 0x20000 else b""
out.write_bytes(rom)
print(f"wrote {out} ({len(rom)} bytes)")
