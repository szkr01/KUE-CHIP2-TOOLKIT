type U8 = number;
type Bit = 0 | 1;
type Phase = 0 | 1 | 2 | 3 | 4;
type RegisterSelector = 0 | 1;
type OperandSelector = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Section = "program" | "data";
type Diagnostic = {
    severity: "error" | "warning";
    message: string;
    line?: number;
    column?: number;
};
type FixedInstructionKind = "NOP" | "HLT" | "OUT" | "IN" | "RCF" | "SCF";
type AluInstructionKind = "SBC" | "ADC" | "SUB" | "ADD" | "EOR" | "OR" | "AND" | "CMP";
type DecodedInstruction = {
    kind: FixedInstructionKind;
    opcode: U8;
} | {
    kind: "Bcc";
    opcode: U8;
    cc: number;
} | {
    kind: "ShiftRotate";
    opcode: U8;
    a: RegisterSelector;
    q: 0 | 1;
    sm: 0 | 1 | 2 | 3;
} | {
    kind: "LD" | "ST" | AluInstructionKind;
    opcode: U8;
    a: RegisterSelector;
    b: OperandSelector;
} | {
    kind: "ILLEGAL";
    opcode: U8;
    reason: string;
};
type EmulatorTrap = {
    kind: "illegal-instruction";
    opcode: U8;
    pc: U8;
    message: string;
};
type CpuState = {
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
type CpuSnapshot = Readonly<Omit<CpuState, "program" | "data">> & {
    readonly program: Uint8Array;
    readonly data: Uint8Array;
};
type PhaseTrace = {
    phase: Phase;
    before: CpuSnapshot;
    after: CpuSnapshot;
};
type InstructionTrace = {
    pcBefore: U8;
    irAfterFetch: U8;
    pcAfter: U8;
    phases: PhaseTrace[];
    after: CpuSnapshot;
    trap?: EmulatorTrap;
};
type RunTrace = {
    instructions: InstructionTrace[];
    after: CpuSnapshot;
    stoppedReason: "halt" | "trap" | "max-instructions";
};
type AssembleSuccess = {
    ok: true;
    program: Uint8Array;
    data: Uint8Array;
    diagnostics: Diagnostic[];
    symbols: ReadonlyMap<string, U8>;
};
type AssembleFailure = {
    ok: false;
    diagnostics: Diagnostic[];
    symbols: ReadonlyMap<string, U8>;
};
type AssembleResult = AssembleSuccess | AssembleFailure;
type DisassembleResult = {
    ok: true;
    lines: string[];
    text: string;
};

declare function assemble(source: string): AssembleResult;

type DisassembleOptions = {
    startAddress?: number;
};
declare function disassemble(bytes: ArrayLike<number>, options?: DisassembleOptions): DisassembleResult;

declare function createInitialCpuState(): CpuState;
declare function snapshotState(state: CpuState): CpuSnapshot;
declare class KueChip2 {
    state: CpuState;
    private pendingShiftFlags;
    constructor(program?: ArrayLike<number>);
    reset(): void;
    loadProgram(bytes: ArrayLike<number>, offset?: number): void;
    loadData(bytes: ArrayLike<number>, offset?: number): void;
    stepPhase(): PhaseTrace;
    stepInstruction(): InstructionTrace;
    run(maxInstructions?: number): RunTrace;
    setInput(value: U8): void;
    readOutput(): U8;
    clearOutputFlag(): void;
    private loadBytes;
    private executePhase;
    private executeP2;
    private executeP3;
    private executeP4;
    private fetchOperandByte;
    private resolveMemoryAddress;
    private readMemoryOperand;
    private writeMemoryOperand;
    private executeAluOnRegister;
    private executeShiftRotate;
    private getRegister;
    private setRegister;
    private decoded;
    private finishInstruction;
    private trapIllegal;
    private trapInternal;
}

type AluResult = {
    result: U8;
    cf?: Bit;
    vf: Bit;
    nf: Bit;
    zf: Bit;
};
declare function executeAlu(kind: AluInstructionKind, lhs: U8, rhs: U8, cf: Bit): AluResult;

declare const BRANCH_MNEMONICS: readonly ["BA", "BNZ", "BZP", "BP", "BNI", "BNC", "BGE", "BGT", "BVF", "BZ", "BN", "BZN", "BNO", "BC", "BLT", "BLE"];
declare const ALU_MNEMONICS: Record<number, AluInstructionKind>;
declare const SHIFT_ROTATE_MNEMONICS: Record<number, string>;
declare function toU8(value: number): U8;
declare function toBit(value: boolean | number): 0 | 1;
declare function bit7(value: number): 0 | 1;
declare function zflag(value: number): 0 | 1;
declare function hexByte(value: number): string;
declare function decodeOpcode(opcode: U8): DecodedInstruction;
declare function instructionLength(decoded: DecodedInstruction): 1 | 2;
declare function branchCond(cc: number, s: {
    cf: 0 | 1;
    vf: 0 | 1;
    nf: 0 | 1;
    zf: 0 | 1;
    ibufFlag: 0 | 1;
    obufFlag: 0 | 1;
}): boolean;

export { ALU_MNEMONICS, type AluInstructionKind, type AssembleResult, BRANCH_MNEMONICS, type Bit, type CpuSnapshot, type CpuState, type DecodedInstruction, type Diagnostic, type DisassembleResult, type EmulatorTrap, type InstructionTrace, KueChip2, type OperandSelector, type Phase, type PhaseTrace, type RegisterSelector, type RunTrace, SHIFT_ROTATE_MNEMONICS, type Section, type U8, assemble, bit7, branchCond, createInitialCpuState, decodeOpcode, disassemble, executeAlu, hexByte, instructionLength, snapshotState, toBit, toU8, zflag };
