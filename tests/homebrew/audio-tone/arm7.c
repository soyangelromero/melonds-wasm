// Bare-metal ARM7 program for the Phase 4 audio test ROM (no libnds). CC0.
// Plays a looping 64-sample PCM16 sine on SPU channel 0 at a known pitch, so the browser test can check
// "non-silent", RMS, and frequency (resampling accuracy) with a ROM that contains nothing from Nintendo.
// Registers: GBATEK "DS Sound" (SOUNDxCNT/SAD/TMR/PNT/LEN at 0x04000400 + 0x10*ch, SOUNDCNT at 0x04000500).
#include <stdint.h>
#define REG32(a) (*(volatile uint32_t *)(a))
#define REG16(a) (*(volatile uint16_t *)(a))

#include "sine.h"  // static const int16_t sine64[64]; amplitude 16000 (about -6 dBFS)

// Must live in main RAM: the SPU cannot read ARM7 WRAM. The linker script places .data at 0x02380000.
__attribute__((section(".data"), aligned(4))) int16_t sample[64];


int main(void) {
  for (int i = 0; i < 64; i++) sample[i] = sine64[i];
  REG16(0x04000304) |= 1;            // POWCNT2: enable sound
  REG16(0x04000500) = 0x807F;        // SOUNDCNT: master enable (bit 15), master volume 127
  // 33513982 / 2 = 16756991 Hz timer clock; rate = 16756991 / (65536 - TIMER) = 28162.7 Hz for TIMER = 65536 - 595.
  // 64 samples per period => 28162.7 / 64 = 440.04 Hz.
  REG32(0x04000404) = (uint32_t)(uintptr_t)sample;  // SOUND0SAD
  REG16(0x04000408) = (uint16_t)(65536 - 595);      // SOUND0TMR
  REG16(0x0400040A) = 0;                            // SOUND0PNT: loop start (words)
  REG32(0x0400040C) = 32;                           // SOUND0LEN: 64 samples * 2 bytes / 4 = 32 words
  // volume 100/127, divider /1, pan centre (64), repeat infinite (1), PCM16 (1), start (bit 31)
  REG32(0x04000400) = 100u | (64u << 16) | (1u << 27) | (1u << 29) | (1u << 31);
  for (;;) { }
}
