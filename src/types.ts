export type U8 = number;
export type Bit = 0 | 1;
export type Phase = 0 | 1 | 2 | 3 | 4;
export type RegisterSelector = 0 | 1;
export type OperandSelector = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Section = "program" | "data";

export type Diagnostic = {
  severity: "error" | "warning";
  message: string;
  line?: number;
  column?: number;
};

export type FixedInstructionKind =
  | "NOP"
  | "HLT"
  | "OUT"
  | "IN"
  | "RCF"
  | "SCF";

export type AluInstructionKind =
  | "SBC"
  | "ADC"
  | "SUB"
  | "ADD"
  | "EOR"
  | "OR"
  | "AND"
  | "CMP";

export type DecodedInstruction =
  | { kind: FixedInstructionKind; opcode: U8 }
  | { kind: "Bcc"; opcode: U8; cc: number }
  | { kind: "ShiftRotate"; opcode: U8; a: RegisterSelector; q: 0 | 1; sm: 0 | 1 | 2 | 3 }
  | { kind: "LD" | "ST" | AluInstructionKind; opcode: U8; a: RegisterSelector; b: OperandSelector }
  | { kind: "ILLEGAL"; opcode: U8; reason: string };

export type EmulatorTrap = {
  kind: "illegal-instruction";
  opcode: U8;
  pc: U8;
  message: string;
};

export type CpuState = {
  acc: U8;
  ix: U8;
  pc: U8;
  ir: U8;
  mar: U8;
  cf: Bit;
  vf: Bit;
  nf: Bit;
  zf: Bit;
  program: Uint8Array;
  data: Uint8Array;
  ibuf: U8;
  obuf: U8;
  ibufFlag: Bit;
  obufFlag: Bit;
  halt: boolean;
  phase: Phase;
  tcf?: Bit;
  decoded?: DecodedInstruction;
  trap?: EmulatorTrap;
};

export type CpuSnapshot = Readonly<Omit<CpuState, "program" | "data">> & {
  readonly program: Uint8Array;
  readonly data: Uint8Array;
};

export type PhaseTrace = {
  phase: Phase;
  before: CpuSnapshot;
  after: CpuSnapshot;
};

export type InstructionTrace = {
  pcBefore: U8;
  irAfterFetch: U8;
  pcAfter: U8;
  phases: PhaseTrace[];
  after: CpuSnapshot;
  trap?: EmulatorTrap;
};

export type RunTrace = {
  instructions: InstructionTrace[];
  after: CpuSnapshot;
  stoppedReason: "halt" | "trap" | "max-instructions";
};

export type AssembleSuccess = {
  ok: true;
  program: Uint8Array;
  data: Uint8Array;
  diagnostics: Diagnostic[];
  symbols: ReadonlyMap<string, U8>;
};

export type AssembleFailure = {
  ok: false;
  diagnostics: Diagnostic[];
  symbols: ReadonlyMap<string, U8>;
};

export type AssembleResult = AssembleSuccess | AssembleFailure;

export type DisassembleResult = {
  ok: true;
  lines: string[];
  text: string;
};
