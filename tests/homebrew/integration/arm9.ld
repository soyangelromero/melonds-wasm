ENTRY(_start)
/* Loaded at 0x02000000 after the 0xE7FFDEFF "decrypted secure area" marker word, so the code starts at 0x02000004. */
MEMORY { RAM (rwx) : ORIGIN = 0x02000004, LENGTH = 0x10000 }
SECTIONS {
  .text : { *(.text.start) *(.text*) *(.rodata*) } > RAM
  .data : { *(.data*) } > RAM
  __stack_top = 0x023FF000;
}
