import { executeAlu } from "./alu.js";
import {
  bit7,
  branchCond,
  decodeOpcode,
  toBit,
  toU8,
  zflag,
} from "../isa/index.js";
import type {
  AluInstructionKind,
  Bit,
  CpuSnapshot,
  CpuState,
  DecodedInstruction,
  EmulatorTrap,
  InstructionTrace,
  OperandSelector,
  Phase,
  PhaseTrace,
  RegisterSelector,
  RunTrace,
  U8,
} from "../types.js";

type PendingShiftFlags = {
  cf: Bit;
  vf: Bit;
  nf: Bit;
  zf: Bit;
};

const ALU_KINDS = new Set<string>(["SBC", "ADC", "SUB", "ADD", "EOR", "OR", "AND", "CMP"]);

export function createInitialCpuState(): CpuState {
  return {
    acc: 0,
    ix: 0,
    pc: 0,
    ir: 0,
    mar: 0,
    cf: 0,
    vf: 0,
    nf: 0,
    zf: 0,
    program: new Uint8Array(256),
    data: new Uint8Array(256),
    ibuf: 0,
    obuf: 0,
    ibufFlag: 0,
    obufFlag: 0,
    halt: false,
    phase: 0,
  };
}

export function snapshotState(state: CpuState): CpuSnapshot {
  return {
    ...state,
    program: new Uint8Array(state.program),
    data: new Uint8Array(state.data),
  };
}

export class KueChip2 {
  state: CpuState;
  private pendingShiftFlags: PendingShiftFlags | undefined;

  constructor(program?: ArrayLike<number>) {
    this.state = createInitialCpuState();
    if (program !== undefined) this.loadProgram(program);
  }

  reset(): void {
    const program = new Uint8Array(this.state.program);
    const data = new Uint8Array(this.state.data);
    this.state = createInitialCpuState();
    this.state.program.set(program);
    this.state.data.set(data);
    this.pendingShiftFlags = undefined;
  }

  loadProgram(bytes: ArrayLike<number>, offset = 0): void {
    this.loadBytes(this.state.program, bytes, offset);
  }

  loadData(bytes: ArrayLike<number>, offset = 0): void {
    this.loadBytes(this.state.data, bytes, offset);
  }

  stepPhase(): PhaseTrace {
    const phase = this.state.phase;
    const before = snapshotState(this.state);
    this.executePhase(phase);
    return { phase, before, after: snapshotState(this.state) };
  }

  stepInstruction(): InstructionTrace {
    const pcBefore = this.state.pc;
    const phases: PhaseTrace[] = [];
    if (this.state.halt || this.state.trap) {
      return {
        pcBefore,
        irAfterFetch: this.state.ir,
        pcAfter: this.state.pc,
        phases,
        after: snapshotState(this.state),
        ...(this.state.trap ? { trap: this.state.trap } : {}),
      };
    }

    do {
      phases.push(this.stepPhase());
    } while (this.state.phase !== 0 && !this.state.trap);

    return {
      pcBefore,
      irAfterFetch: this.state.ir,
      pcAfter: this.state.pc,
      phases,
      after: snapshotState(this.state),
      ...(this.state.trap ? { trap: this.state.trap } : {}),
    };
  }

  run(maxInstructions = 10000): RunTrace {
    const instructions: InstructionTrace[] = [];
    for (let i = 0; i < maxInstructions; i += 1) {
      if (this.state.trap) {
        return { instructions, after: snapshotState(this.state), stoppedReason: "trap" };
      }
      if (this.state.halt) {
        return { instructions, after: snapshotState(this.state), stoppedReason: "halt" };
      }
      instructions.push(this.stepInstruction());
    }
    if (this.state.trap) return { instructions, after: snapshotState(this.state), stoppedReason: "trap" };
    if (this.state.halt) return { instructions, after: snapshotState(this.state), stoppedReason: "halt" };
    return { instructions, after: snapshotState(this.state), stoppedReason: "max-instructions" };
  }

  setInput(value: U8): void {
    this.state.ibuf = toU8(value);
    this.state.ibufFlag = 1;
  }

  readOutput(): U8 {
    return this.state.obuf;
  }

  clearOutputFlag(): void {
    this.state.obufFlag = 0;
  }

  private loadBytes(target: Uint8Array, bytes: ArrayLike<number>, offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > 255) {
      throw new RangeError("offset must be an integer in 0..255");
    }
    if (offset + bytes.length > 256) {
      throw new RangeError("bytes do not fit in 256-byte memory");
    }
    for (let i = 0; i < bytes.length; i += 1) {
      target[offset + i] = toU8(bytes[i] ?? 0);
    }
  }

  private executePhase(phase: Phase): void {
    if (this.state.trap) return;
    if (this.state.halt && phase === 0) return;

    switch (phase) {
      case 0:
        this.state.mar = this.state.pc;
        this.state.pc = toU8(this.state.pc + 1);
        this.state.phase = 1;
        return;
      case 1:
        this.state.ir = this.state.program[this.state.mar] ?? 0;
        this.state.decoded = decodeOpcode(this.state.ir);
        this.state.phase = 2;
        return;
      case 2:
        this.executeP2();
        return;
      case 3:
        this.executeP3();
        return;
      case 4:
        this.executeP4();
        return;
    }
  }

  private executeP2(): void {
    const decoded = this.decoded();
    switch (decoded.kind) {
      case "ILLEGAL":
        this.trapIllegal(decoded);
        return;
      case "NOP":
        this.finishInstruction();
        return;
      case "HLT":
        this.state.halt = true;
        this.finishInstruction();
        return;
      case "OUT":
        this.state.obuf = this.state.acc;
        this.state.phase = 3;
        return;
      case "IN":
        this.state.acc = this.state.ibuf;
        this.state.phase = 3;
        return;
      case "RCF":
        this.state.cf = 0;
        this.finishInstruction();
        return;
      case "SCF":
        this.state.cf = 1;
        this.finishInstruction();
        return;
      case "Bcc":
        this.fetchOperandByte();
        this.state.phase = 3;
        return;
      case "ShiftRotate":
        this.executeShiftRotate(decoded);
        this.state.phase = 3;
        return;
      case "LD":
        if (decoded.b <= 1) {
          this.setRegister(decoded.a, this.getRegister(decoded.b as RegisterSelector));
          this.finishInstruction();
        } else {
          this.fetchOperandByte();
          this.state.phase = 3;
        }
        return;
      case "ST":
        this.fetchOperandByte();
        this.state.phase = 3;
        return;
      case "SBC":
      case "ADC":
      case "SUB":
      case "ADD":
      case "EOR":
      case "OR":
      case "AND":
      case "CMP":
        if (decoded.b <= 1) {
          this.executeAluOnRegister(decoded.kind, decoded.a, this.getRegister(decoded.b as RegisterSelector));
          this.finishInstruction();
        } else {
          this.fetchOperandByte();
          this.state.phase = 3;
        }
        return;
    }
  }

  private executeP3(): void {
    const decoded = this.decoded();
    switch (decoded.kind) {
      case "OUT":
        this.state.obufFlag = 1;
        this.finishInstruction();
        return;
      case "IN":
        this.state.ibufFlag = 0;
        this.finishInstruction();
        return;
      case "Bcc":
        if (branchCond(decoded.cc, this.state)) {
          this.state.pc = this.state.program[this.state.mar] ?? 0;
        }
        this.finishInstruction();
        return;
      case "ShiftRotate":
        if (this.pendingShiftFlags === undefined) {
          this.trapInternal("Missing shift flags");
          return;
        }
        this.state.cf = this.pendingShiftFlags.cf;
        this.state.vf = this.pendingShiftFlags.vf;
        this.state.nf = this.pendingShiftFlags.nf;
        this.state.zf = this.pendingShiftFlags.zf;
        this.pendingShiftFlags = undefined;
        this.finishInstruction();
        return;
      case "LD":
        if (decoded.b === 2 || decoded.b === 3) {
          this.setRegister(decoded.a, this.state.program[this.state.mar] ?? 0);
          this.finishInstruction();
        } else {
          this.resolveMemoryAddress(decoded.b);
          this.state.phase = 4;
        }
        return;
      case "ST":
        this.resolveMemoryAddress(decoded.b);
        this.state.phase = 4;
        return;
      case "SBC":
      case "ADC":
      case "SUB":
      case "ADD":
      case "EOR":
      case "OR":
      case "AND":
      case "CMP":
        if (decoded.b === 2 || decoded.b === 3) {
          this.executeAluOnRegister(decoded.kind, decoded.a, this.state.program[this.state.mar] ?? 0);
          this.finishInstruction();
        } else {
          this.resolveMemoryAddress(decoded.b);
          this.state.phase = 4;
        }
        return;
    }
  }

  private executeP4(): void {
    const decoded = this.decoded();
    switch (decoded.kind) {
      case "LD":
        this.setRegister(decoded.a, this.readMemoryOperand(decoded.b));
        this.finishInstruction();
        return;
      case "ST":
        this.writeMemoryOperand(decoded.b, this.getRegister(decoded.a));
        this.finishInstruction();
        return;
      case "SBC":
      case "ADC":
      case "SUB":
      case "ADD":
      case "EOR":
      case "OR":
      case "AND":
      case "CMP":
        this.executeAluOnRegister(decoded.kind, decoded.a, this.readMemoryOperand(decoded.b));
        this.finishInstruction();
        return;
    }
  }

  private fetchOperandByte(): void {
    this.state.mar = this.state.pc;
    this.state.pc = toU8(this.state.pc + 1);
  }

  private resolveMemoryAddress(b: OperandSelector): void {
    const displacement = this.state.program[this.state.mar] ?? 0;
    this.state.mar = b >= 6 ? toU8(this.state.ix + displacement) : displacement;
  }

  private readMemoryOperand(b: OperandSelector): U8 {
    return b === 4 || b === 6 ? this.state.program[this.state.mar] ?? 0 : this.state.data[this.state.mar] ?? 0;
  }

  private writeMemoryOperand(b: OperandSelector, value: U8): void {
    if (b === 4 || b === 6) this.state.program[this.state.mar] = toU8(value);
    else this.state.data[this.state.mar] = toU8(value);
  }

  private executeAluOnRegister(kind: AluInstructionKind, a: RegisterSelector, rhs: U8): void {
    const lhs = this.getRegister(a);
    const result = executeAlu(kind, lhs, rhs, this.state.cf);
    if (kind !== "CMP") this.setRegister(a, result.result);
    if (result.cf !== undefined) this.state.cf = result.cf;
    this.state.vf = result.vf;
    this.state.nf = result.nf;
    this.state.zf = result.zf;
  }

  private executeShiftRotate(decoded: Extract<DecodedInstruction, { kind: "ShiftRotate" }>): void {
    const old = this.getRegister(decoded.a);
    let result: U8;
    let cf: Bit;
    let vf: Bit;
    const op = decoded.opcode & 0x47;

    switch (op & 0x07) {
      case 0x00:
        result = toU8((old & 0x80) | (old >> 1));
        cf = toBit(old & 0x01);
        vf = 0;
        break;
      case 0x01:
        result = toU8(old << 1);
        cf = bit7(old);
        vf = toBit(bit7(old) ^ bit7(result));
        break;
      case 0x02:
        result = toU8(old >> 1);
        cf = toBit(old & 0x01);
        vf = 0;
        break;
      case 0x03:
        result = toU8(old << 1);
        cf = bit7(old);
        vf = 0;
        break;
      case 0x04:
        result = toU8((this.state.cf << 7) | (old >> 1));
        cf = toBit(old & 0x01);
        vf = 0;
        break;
      case 0x05:
        result = toU8((old << 1) | this.state.cf);
        cf = bit7(old);
        vf = toBit(bit7(old) ^ bit7(result));
        break;
      case 0x06:
        result = toU8((old >> 1) | ((old & 0x01) << 7));
        cf = toBit(old & 0x01);
        vf = 0;
        break;
      case 0x07:
        result = toU8((old << 1) | ((old >> 7) & 1));
        cf = bit7(old);
        vf = 0;
        break;
      default:
        result = old;
        cf = 0;
        vf = 0;
    }

    this.setRegister(decoded.a, result);
    this.state.tcf = cf;
    this.pendingShiftFlags = { cf, vf, nf: bit7(result), zf: zflag(result) };
  }

  private getRegister(selector: RegisterSelector): U8 {
    return selector === 0 ? this.state.acc : this.state.ix;
  }

  private setRegister(selector: RegisterSelector, value: U8): void {
    if (selector === 0) this.state.acc = toU8(value);
    else this.state.ix = toU8(value);
  }

  private decoded(): DecodedInstruction {
    if (this.state.decoded !== undefined) return this.state.decoded;
    const decoded = decodeOpcode(this.state.ir);
    this.state.decoded = decoded;
    return decoded;
  }

  private finishInstruction(): void {
    this.state.phase = 0;
  }

  private trapIllegal(decoded: Extract<DecodedInstruction, { kind: "ILLEGAL" }>): void {
    const trap: EmulatorTrap = {
      kind: "illegal-instruction",
      opcode: decoded.opcode,
      pc: toU8(this.state.pc - 1),
      message: decoded.reason,
    };
    this.state.trap = trap;
    this.state.halt = true;
    this.finishInstruction();
  }

  private trapInternal(message: string): void {
    this.state.trap = {
      kind: "illegal-instruction",
      opcode: this.state.ir,
      pc: toU8(this.state.pc - 1),
      message,
    };
    this.state.halt = true;
    this.finishInstruction();
  }
}

function isAluDecoded(
  decoded: DecodedInstruction,
): decoded is Extract<DecodedInstruction, { kind: AluInstructionKind }> {
  return ALU_KINDS.has(decoded.kind);
}
