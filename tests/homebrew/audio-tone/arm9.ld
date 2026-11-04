ENTRY(_start)
MEMORY { RAM (rwx) : ORIGIN = 0x02000000, LENGTH = 0x10000 }
SECTIONS {
  .text : { *(.text.start) *(.text*) *(.rodata*) } > RAM
  .data : { *(.data*) } > RAM
  __stack_top = ORIGIN(RAM) + LENGTH(RAM);
}
