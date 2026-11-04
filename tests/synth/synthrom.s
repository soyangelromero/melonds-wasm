@ ARM9 program of the synthetic test cartridge (tests/lib/synth-rom.mjs). Original code, no Nintendo content.
@ Every vblank it increments a counter and fills the top screen (VRAM-A direct display) with a counter-derived colour,
@ and at frame 30 / 60 it writes 16 bytes to the cartridge EEPROM over the cart SPI bus (0xA0.. then 0xB0..) at 0x10.
@ Assemble + link at the load address: tests/synth/build.sh (prints the word array pasted into tests/lib/synth-rom.mjs).
@ The program is linked at 0x02000004 because the first word of the ARM9 image is the 0xE7FFDEFF marker (see synth-rom.mjs).
.arm
.text
.global _start
_start:
  ldr sp, =0x023FF000
  ldr r12, =0x04000000
  ldr r0, =0x8003
  ldr r1, =0x04000304
  strh r0, [r1]                @ POWCNT1: LCD on, engine A on, engine A on top screen
  mov r0, #0x80
  strb r0, [r12, #0x240]       @ VRAMCNT_A: enabled, LCDC mapping at 0x06800000
  ldr r0, =0x00020000
  str r0, [r12]                @ DISPCNT A: display mode 2 (VRAM direct)
  ldr r1, =0x04000204
  ldrh r0, [r1]
  bic r0, r0, #0x800
  strh r0, [r1]                @ EXMEMCNT: the ARM9 owns the cartridge slot
  mov r5, #0
  ldr r6, =0x06800000
main:
1: ldrh r0, [r12, #4]
  tst r0, #1
  beq 1b                       @ wait for vblank
  add r5, r5, #1
  ldr r0, =0x04210421
  mul r1, r5, r0
  mov r2, r1
  mov r3, r1
  mov r4, r1
  mov r7, r1
  mov r8, r1
  mov r9, r1
  mov r10, r1
  mov r11, r6
  ldr r0, =3072
2: stmia r11!, {r1-r4, r7-r10}
  subs r0, r0, #1
  bne 2b
  cmp r5, #30
  moveq r8, #0xA0
  bleq eewrite
  cmp r5, #60
  moveq r8, #0xB0
  bleq eewrite
3: ldrh r0, [r12, #4]
  tst r0, #1
  bne 3b                       @ wait for the end of vblank
  b main

@ r8 = first data byte; writes r8..r8+15 to EEPROM address 0x0010 (2-byte addressing, 8 KiB part)
eewrite:
  stmfd sp!, {lr}
  ldr r2, =0x040001A0
  ldr r3, =0xA000              @ enable | SPI mode, chip select released after the byte
  ldr r4, =0xA040              @ same, chip select held
  strh r3, [r2]
  mov r0, #6
  bl spi                       @ WREN
  strh r4, [r2]
  mov r0, #2
  bl spi                       @ WRITE
  mov r0, #0
  bl spi                       @ address high
  mov r0, #0x10
  bl spi                       @ address low
  mov r7, #0
4: add r0, r7, r8
  cmp r7, #15
  strheq r3, [r2]              @ release chip select with the last byte
  bl spi
  add r7, r7, #1
  cmp r7, #16
  bne 4b
  ldmfd sp!, {pc}

spi:
  strb r0, [r2, #2]
5: ldrh r1, [r2]
  tst r1, #0x80
  bne 5b
  bx lr
.ltorg
