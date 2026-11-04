// ARM9 program of the integration test ROM (tests/integration-browser.mjs). Original code, CC0, nothing from Nintendo.
//  - draws the top screen (VRAM-A direct display) as a pure function of the pressed keys (so a key press changes the image,
//    and the image is stable otherwise); the bottom screen stays black, the core draws its touch cursor over it
//  - counts vblanks at 0x02200000 (the test reads it to prove that a savestate rewound the game)
//  - writes 16 bytes to the cartridge EEPROM at frame 30 (0xA0..) and 60 (0xB0..), at offset 0x10 (the "save")
// The cheat target 0x02300000..0x023000FF is never touched here.
#include <stdint.h>
#define R16(a) (*(volatile uint16_t *)(a))
#define R8(a) (*(volatile uint8_t *)(a))
#define R32(a) (*(volatile uint32_t *)(a))
#define AUXSPICNT 0x040001A0
#define VRAM 0x06800000

static void spi(uint8_t b) { R8(AUXSPICNT + 2) = b; while (R16(AUXSPICNT) & 0x80) { } }

static void eewrite(uint8_t first) {
  R16(AUXSPICNT) = 0xA000; spi(6);                 // WREN
  R16(AUXSPICNT) = 0xA040; spi(2); spi(0); spi(0x10); // WRITE, 2-byte address 0x0010 (8 KiB part)
  for (int i = 0; i < 16; i++) { if (i == 15) R16(AUXSPICNT) = 0xA000; spi((uint8_t)(first + i)); }
}

int main(void) {
  R16(0x04000304) = 0x8003;          // POWCNT1: LCD on, engine A on the top screen
  R8(0x04000240) = 0x80;             // VRAMCNT_A: enabled, LCDC mapping at 0x06800000
  R32(0x04000000) = 0x00020000;      // DISPCNT A: display mode 2 (VRAM direct)
  R16(0x04000204) &= ~0x0800;        // EXMEMCNT: the ARM9 owns the cartridge slot
  uint32_t frame = 0;
  for (;;) {
    while (!(R16(0x04000004) & 1)) { }
    frame++;
    R32(0x02200000) = frame;
    uint16_t keys = (uint16_t)(~R16(0x04000130) & 0x3FF);
    uint16_t colour = keys ? (uint16_t)(0x8000 | 0x001F | ((keys * 0x21) & 0x7FE0)) : 0xFC00; // no keys: blue; keys: red-ish, key-dependent
    volatile uint32_t *p = (volatile uint32_t *)VRAM;
    uint32_t two = ((uint32_t)colour << 16) | colour;
    for (int i = 0; i < 256 * 192 / 2; i++) p[i] = two;
    if (frame == 30) eewrite(0xA0);
    if (frame == 60) eewrite(0xB0);
    while (R16(0x04000004) & 1) { }
  }
}
