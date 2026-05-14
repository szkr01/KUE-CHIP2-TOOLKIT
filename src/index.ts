export { assemble } from "./assembler/index.js";
export { disassemble } from "./disassembler/index.js";
export { KueChip2, createInitialCpuState, snapshotState, executeAlu } from "./emulator/index.js";
export {
  ALU_MNEMONICS,
  BRANCH_MNEMONICS,
  SHIFT_ROTATE_MNEMONICS,
  bit7,
  branchCond,
  decodeOpcode,
  hexByte,
  instructionLength,
  toBit,
  toU8,
  zflag,
} from "./isa/index.js";
export type {
  AluInstructionKind,
  AssembleResult,
  Bit,
  CpuSnapshot,
  CpuState,
  DecodedInstruction,
  Diagnostic,
  DisassembleResult,
  EmulatorTrap,
  InstructionTrace,
  OperandSelector,
  Phase,
  PhaseTrace,
  RegisterSelector,
  RunTrace,
  Section,
  U8,
} from "./types.js";
