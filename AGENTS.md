# Repository Map

- `documents/`: KUE-CHIP2 implementation specification and reference notes.
- `src/isa/`: opcode decoding, instruction lengths, mnemonics, and operand mode metadata.
- `src/emulator/`: CPU state, ALU helpers, phase execution, instruction stepping, and run loop.
- `src/assembler/`: two-pass assembler, expression parsing, labels, directives, and diagnostics.
- `src/disassembler/`: byte-to-assembly formatting and illegal opcode display.
- `tests/`: Vitest conformance tests based on the specification.
- `dist/`: generated ESM JavaScript and type declarations from `npm run build`.
