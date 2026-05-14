import {
  BRANCH_MNEMONICS,
  SHIFT_ROTATE_MNEMONICS,
  decodeOpcode,
  hexByte,
  instructionLength,
} from "../isa/index.js";
import type { DecodedInstruction, DisassembleResult, OperandSelector } from "../types.js";

export type DisassembleOptions = {
  startAddress?: number;
};

export function disassemble(bytes: ArrayLike<number>, options: DisassembleOptions = {}): DisassembleResult {
  const lines: string[] = [];
  const startAddress = options.startAddress ?? 0;
  let i = 0;
  while (i < bytes.length) {
    const address = (startAddress + i) & 0xff;
    const opcode = (bytes[i] ?? 0) & 0xff;
    const decoded = decodeOpcode(opcode);
    const length = instructionLength(decoded);
    const operand = length === 2 ? bytes[i + 1] : undefined;
    if (length === 2 && operand === undefined) {
      lines.push(`${hexByte(address)}: .db ${hexByte(opcode)} ; truncated`);
      i += 1;
      continue;
    }
    lines.push(`${hexByte(address)}: ${formatInstruction(decoded, operand)}`);
    i += length;
  }
  return { ok: true, lines, text: lines.join("\n") };
}

function formatInstruction(decoded: DecodedInstruction, operand?: number): string {
  switch (decoded.kind) {
    case "ILLEGAL":
      return `.db ${hexByte(decoded.opcode)}`;
    case "NOP":
    case "HLT":
    case "OUT":
    case "IN":
    case "RCF":
    case "SCF":
      return decoded.kind;
    case "Bcc":
      return `${BRANCH_MNEMONICS[decoded.cc] ?? "BA"} ${hexByte(operand ?? 0)}`;
    case "ShiftRotate": {
      const baseOpcode = 0x40 | (decoded.opcode & 0x07);
      return `${SHIFT_ROTATE_MNEMONICS[baseOpcode] ?? "SRA"} ${decoded.a === 0 ? "ACC" : "IX"}`;
    }
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
      return `${decoded.kind} ${decoded.a === 0 ? "ACC" : "IX"}, ${formatOperand(decoded.b, operand)}`;
  }
}

function formatOperand(selector: OperandSelector, operand?: number): string {
  switch (selector) {
    case 0:
      return "ACC";
    case 1:
      return "IX";
    case 2:
    case 3:
      return hexByte(operand ?? 0);
    case 4:
      return `[${hexByte(operand ?? 0)}]`;
    case 5:
      return `(${hexByte(operand ?? 0)})`;
    case 6:
      return `[IX+${hexByte(operand ?? 0)}]`;
    case 7:
      return `(IX+${hexByte(operand ?? 0)})`;
  }
}
