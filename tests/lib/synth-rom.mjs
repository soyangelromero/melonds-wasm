// Synthetic Nintendo DS cartridge for the Phase 6 tests. It is original code (tests/synth/synthrom.s), not a Nintendo
// product and not a homebrew download: a 64 KiB ROM whose ARM9 draws a counter-driven colour on the top screen every
// frame and writes 16 bytes to the cartridge EEPROM at frames 30 (0xA0..0xAF) and 60 (0xB0..0xBF), at offset 0x10.
// The game code is "ZZZE" (not in melonDS's ROM database) and the ARM9 offset is >= 0x8000 (below that melonDS overwrites the first 2 KiB as a "secure area"), so melonDS treats it as a
// retail cart with its default 8 KiB EEPROM (NDSCart.cpp: SaveMemType = 2).
// Regenerate the machine code with tests/synth/build.sh if the source changes (needs llvm-mc and ld.lld with the ARM target).
export const SYNTH_ARM9_WORDS = [
  0xe59fd114, 0xe3a0c301, 0xe59f0110, 0xe59f1110, 0xe1c100b0, 0xe3a00080, 0xe5cc0240, 0xe3a00802, 0xe58c0000, 0xe59f10fc, 0xe1d100b0, 0xe3c00b02, 0xe1c100b0, 0xe3a05000, 0xe3a0651a, 0xe1dc00b4, 0xe3100001, 0x0afffffc, 0xe2855001, 0xe59f00d8, 0xe0010095, 0xe1a02001, 0xe1a03001, 0xe1a04001, 0xe1a07001, 0xe1a08001, 0xe1a09001, 0xe1a0a001, 0xe1a0b006, 0xe3a00b03, 0xe8ab079e, 0xe2500001, 0x1afffffc, 0xe355001e, 0x03a080a0, 0x0b000006, 0xe355003c, 0x03a080b0, 0x0b000003, 0xe1dc00b4, 0xe3100001, 0x1afffffc, 0xeaffffe3, 0xe92d4000, 0xe59f2078, 0xe3a03a0a, 0xe59f4074, 0xe1c230b0, 0xe3a00006, 0xeb00000f, 0xe1c240b0, 0xe3a00002, 0xeb00000c, 0xe3a00000, 0xeb00000a, 0xe3a00010, 0xeb000008, 0xe3a07000, 0xe0870008, 0xe357000f, 0x01c230b0, 0xeb000003, 0xe2877001, 0xe3570010, 0x1afffff8, 0xe8bd8000, 0xe5c20002, 0xe1d210b0, 0xe3110080, 0x1afffffc, 0xe12fff1e, 0x023ff000, 0x00008003, 0x04000304, 0x04000204, 0x04210421, 0x040001a0, 0x0000a040,
];
export const SYNTH_SAVE_SIZE = 8192;
export const SYNTH_WRITE_OFFSET = 0x10;

/** @param {{homebrew?: boolean}} opts homebrew = game code "####": melonDS treats it as homebrew, so there is no save memory. */
export function buildSynthRom({ words = SYNTH_ARM9_WORDS, homebrew = false } = {}) {
  const rom = new Uint8Array(0x10000);
  const dv = new DataView(rom.buffer);
  rom.set(new TextEncoder().encode("MDSSYNTH"), 0x00);        // title
  rom.set(new TextEncoder().encode(homebrew ? "####" : "ZZZE"), 0x0c);             // game code
  rom.set(new TextEncoder().encode("00"), 0x10);               // maker code
  dv.setUint32(0x14, 0, true);                                  // device capacity (128 KiB << 0)
  dv.setUint32(0x20, 0x8000, true);  dv.setUint32(0x24, 0x02000004, true);  dv.setUint32(0x28, 0x02000000, true);
  dv.setUint32(0x2c, 4 + words.length * 4, true);    // ARM9 offset / entry / ram address / size
  dv.setUint32(0x30, 0x9000, true);  dv.setUint32(0x34, 0x037f8000, true);  dv.setUint32(0x38, 0x037f8000, true);
  dv.setUint32(0x3c, 4, true);                                  // ARM7: one instruction
  dv.setUint16(0x15c, 0xcf56, true);                            // logo CRC16 field melonDS checks (the logo bitmap itself is NOT included)
  dv.setUint32(0x80, 0x9004, true);                             // used ROM size
  dv.setUint32(0x84, 0x4000, true);                             // header size
  // melonDS refuses retail-looking ROMs whose secure area is still encrypted (no native BIOS): 0xE7FFDEFF at ARM9 offset 0
  // is the marker of a decrypted dump (config/console.cpp), so the program starts one word later.
  dv.setUint32(0x8000, 0xe7ffdeff, true);
  words.forEach((w, i) => dv.setUint32(0x8004 + i * 4, w, true));
  dv.setUint32(0x9000, 0xeafffffe, true);                       // ARM7: b .
  return rom;
}
