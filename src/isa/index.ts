import type { AluInstructionKind, DecodedInstruction, OperandSelector, U8 } from "../types.js";

export const BRANCH_MNEMONICS = [
  "BA",
  "BNZ",
  "BZP",
  "BP",
  "BNI",
  "BNC",
  "BGE",
  "BGT",
  "BVF",
  "BZ",
  "BN",
  "BZN",
  "BNO",
  "BC",
  "BLT",
  "BLE",
] as const;

export const ALU_MNEMONICS: Record<number, AluInstructionKind> = {
  0x8: "SBC",
  0x9: "ADC",
  0xa: "SUB",
  0xb: "ADD",
  0xc: "EOR",
  0xd: "OR",
  0xe: "AND",
  0xf: "CMP",
};

export const SHIFT_ROTATE_MNEMONICS: Record<number, string> = {
  0x40: "SRA",
  0x41: "SLA",
  0x42: "SRL",
  0x43: "SLL",
  0x44: "RRA",
  0x45: "RLA",
  0x46: "RRL",
  0x47: "RLL",
};

export function toU8(value: number): U8 {
  return value & 0xff;
}

export function toBit(value: boolean | number): 0 | 1 {
  return value ? 1 : 0;
}

export function bit7(value: number): 0 | 1 {
  return (value & 0x80) !== 0 ? 1 : 0;
}

export function zflag(value: number): 0 | 1 {
  return (value & 0xff) === 0 ? 1 : 0;
}

export function hexByte(value: number): string {
  return `${toU8(value).toString(16).toUpperCase().padStart(2, "0")}H`;
}

export function decodeOpcode(opcode: U8): DecodedInstruction {
  const op = toU8(opcode);
  if ((op & 0xf8) === 0x00) return { kind: "NOP", opcode: op };
  if ((op & 0xf8) === 0x08) return { kind: "HLT", opcode: op };
  if ((op & 0xf0) === 0x50) return { kind: "HLT", opcode: op };
  if ((op & 0xf8) === 0x10) return { kind: "OUT", opcode: op };
  if ((op & 0xf8) === 0x18) return { kind: "IN", opcode: op };
  if ((op & 0xf8) === 0x20) return { kind: "RCF", opcode: op };
  if ((op & 0xf8) === 0x28) return { kind: "SCF", opcode: op };
  if ((op & 0xf0) === 0x30) return { kind: "Bcc", opcode: op, cc: op & 0x0f };
  if ((op & 0xf0) === 0x40) {
    return {
      kind: "ShiftRotate",
      opcode: op,
      a: ((op >> 3) & 1) as 0 | 1,
      q: ((op >> 2) & 1) as 0 | 1,
      sm: (op & 3) as 0 | 1 | 2 | 3,
    };
  }

  const group = (op >> 4) & 0x0f;
  const a = ((op >> 3) & 1) as 0 | 1;
  const b = (op & 0x07) as OperandSelector;

  if (group === 0x6) return { kind: "LD", opcode: op, a, b };
  if (group === 0x7) {
    if (b <= 0x3) {
      return { kind: "ILLEGAL", opcode: op, reason: "ST requires a memory operand" };
    }
    return { kind: "ST", opcode: op, a, b };
  }
  const alu = ALU_MNEMONICS[group];
  if (alu !== undefined) return { kind: alu, opcode: op, a, b };

  return { kind: "ILLEGAL", opcode: op, reason: "Undefined opcode" };
}

export function instructionLength(decoded: DecodedInstruction): 1 | 2 {
  switch (decoded.kind) {
    case "Bcc":
      return 2;
    case "LD":
    case "ST":
    case "SBC":
    case "ADC":
    case "SUB":
    case "ADD":
    case "EOR":
    case "OR":
    case "AND":
    case "CMP":
      return decoded.b <= 1 ? 1 : 2;
    default:
      return 1;
  }
}

export function branchCond(cc: number, s: {
  cf: 0 | 1;
  vf: 0 | 1;
  nf: 0 | 1;
  zf: 0 | 1;
  ibufFlag: 0 | 1;
  obufFlag: 0 | 1;
}): boolean {
  switch (cc & 0xf) {
    case 0x0:
      return true;
    case 0x1:
      return s.zf === 0;
    case 0x2:
      return s.nf === 0;
    case 0x3:
      return (s.nf | s.zf) === 0;
    case 0x4:
      return s.ibufFlag === 0;
    case 0x5:
      return s.cf === 0;
    case 0x6:
      return (s.vf ^ s.nf) === 0;
    case 0x7:
      return ((s.vf ^ s.nf) | s.zf) === 0;
    case 0x8:
      return s.vf === 1;
    case 0x9:
      return s.zf === 1;
    case 0xa:
      return s.nf === 1;
    case 0xb:
      return (s.nf | s.zf) === 1;
    case 0xc:
      return s.obufFlag === 1;
    case 0xd:
      return s.cf === 1;
    case 0xe:
      return (s.vf ^ s.nf) === 1;
    case 0xf:
      return ((s.vf ^ s.nf) | s.zf) === 1;
    default:
      return false;
  }
}

export function isAluKind(kind: DecodedInstruction["kind"]): kind is AluInstructionKind {
  return Object.values(ALU_MNEMONICS).includes(kind as AluInstructionKind);
}
