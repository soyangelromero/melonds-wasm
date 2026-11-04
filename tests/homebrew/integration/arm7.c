// ARM7 program of the integration test ROM. Original code, CC0, nothing from Nintendo.
//  - audio: looping 64-sample sine on SPU channel 0 (about 440 Hz), identical to tests/homebrew/audio-tone/arm7.c
//  - IRQ: enables the ARM7 VBlank interrupt (IME, IE, DISPSTAT, CPSR.I) with an empty handler. melonDS runs the Action Replay
//    engine from the ARM7 VBlank interrupt entry, so a cheat needs a game that takes that interrupt (nmap.nds does as well).
#include <stdint.h>
#define REG32(a) (*(volatile uint32_t *)(a))
#define REG16(a) (*(volatile uint16_t *)(a))
#include "sine.h"
__attribute__((section(".data"), aligned(4))) int16_t sample[64];

static void irq_handler(void) { REG32(0x04000214) = REG32(0x04000214); } // acknowledge every pending source

int main(void) {
  for (int i = 0; i < 64; i++) sample[i] = sine64[i];
  REG32(0x0380FFFC) = (uint32_t)(uintptr_t)irq_handler; // ARM7 IRQ vector the BIOS jumps through
  REG16(0x04000004) |= 8;            // DISPSTAT: VBlank IRQ enable
  REG32(0x04000210) = 1;             // IE: VBlank
  REG32(0x04000214) = 0xFFFFFFFF;    // IF: clear
  REG32(0x04000208) = 1;             // IME
  __asm__ volatile("mrs r0, cpsr\n\tbic r0, r0, #0x80\n\tmsr cpsr_c, r0" ::: "r0", "memory");
  REG16(0x04000304) |= 1;            // POWCNT2: enable sound
  REG16(0x04000500) = 0x807F;        // SOUNDCNT: master enable, volume 127
  REG32(0x04000404) = (uint32_t)(uintptr_t)sample;  // SOUND0SAD
  REG16(0x04000408) = (uint16_t)(65536 - 595);      // SOUND0TMR -> 28162.7 Hz, 64 samples per period => 440.04 Hz
  REG16(0x0400040A) = 0;
  REG32(0x0400040C) = 32;
  REG32(0x04000400) = 100u | (64u << 16) | (1u << 27) | (1u << 29) | (1u << 31);
  for (;;) { }
}
