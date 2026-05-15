#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { assemble } from "./assembler/index.js";
import { disassemble } from "./disassembler/index.js";
import { KueChip2 } from "./emulator/index.js";
import { decodeOpcode, hexByte, instructionLength } from "./isa/index.js";
import type { AssembleResult, AssembleSuccess, CpuSnapshot, InstructionTrace, U8 } from "./types.js";

type Io = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

type ParsedArgs = {
  command: string | undefined;
  file: string | undefined;
  data: Assignment[];
  dumps: DumpSpec[];
  maxInstructions: number;
  help: boolean;
};

type Assignment = {
  address: string;
  value: string;
};

type DumpSpec = {
  address: string;
  length: string;
};

const DEFAULT_MAX_INSTRUCTIONS = 10000;

export function runCli(argv: string[], io: Io = { stdout: process.stdout, stderr: process.stderr }): number {
  let parsed: ParsedArgs | string;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    writeLine(io.stderr, errorMessage(error));
    writeLine(io.stderr, "");
    writeLine(io.stderr, usage());
    return 1;
  }
  if (typeof parsed === "string") {
    writeLine(io.stderr, parsed);
    writeLine(io.stderr, "");
    writeLine(io.stderr, usage());
    return 1;
  }

  if (parsed.help || parsed.command === undefined) {
    writeLine(io.stdout, usage());
    return 0;
  }

  if (parsed.file === undefined) {
    writeLine(io.stderr, `Missing ASM file for '${parsed.command}'.`);
    return 1;
  }

  let source: string;
  try {
    source = readFileSync(parsed.file, "utf8");
  } catch (error) {
    writeLine(io.stderr, `Cannot read ${parsed.file}: ${errorMessage(error)}`);
    return 1;
  }

  const assembled = assemble(source);
  if (!assembled.ok) {
    printDiagnostics(assembled, io);
    return 1;
  }
  if (assembled.diagnostics.length > 0) printDiagnostics(assembled, io);

  try {
    switch (parsed.command) {
      case "assemble":
        printAssembly(assembled, io);
        return 0;
      case "run":
        return runProgram(assembled, parsed, io, false);
      case "trace":
        return runProgram(assembled, parsed, io, true);
      default:
        writeLine(io.stderr, `Unknown command '${parsed.command}'.`);
        writeLine(io.stderr, "");
        writeLine(io.stderr, usage());
        return 1;
    }
  } catch (error) {
    writeLine(io.stderr, errorMessage(error));
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs | string {
  const parsed: ParsedArgs = {
    command: undefined,
    file: undefined,
    data: [],
    dumps: [],
    maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
    help: false,
  };

  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--data": {
        const value = argv[++i];
        if (value === undefined) return "--data requires ADDR=BYTE.";
        parsed.data.push(parseAssignment(value));
        break;
      }
      case "--dump-data": {
        const value = argv[++i];
        if (value === undefined) return "--dump-data requires ADDR:LENGTH.";
        parsed.dumps.push(parseDumpSpec(value));
        break;
      }
      case "--max-instructions": {
        const value = argv[++i];
        if (value === undefined) return "--max-instructions requires a number.";
        const maxInstructions = Number.parseInt(value, 10);
        if (!Number.isInteger(maxInstructions) || maxInstructions <= 0) {
          return "--max-instructions must be a positive integer.";
        }
        parsed.maxInstructions = maxInstructions;
        break;
      }
      default:
        if (arg.startsWith("-")) return `Unknown option '${arg}'.`;
        positionals.push(arg);
        break;
    }
  }

  if (positionals.length > 2) return `Unexpected argument '${positionals[2]}'.`;
  parsed.command = positionals[0];
  parsed.file = positionals[1];
  return parsed;
}

function parseAssignment(text: string): Assignment {
  const [address, value, extra] = text.split("=");
  if (address === undefined || value === undefined || extra !== undefined || address.length === 0 || value.length === 0) {
    throw new Error(`Invalid assignment '${text}'. Use ADDR=BYTE.`);
  }
  return { address, value };
}

function parseDumpSpec(text: string): DumpSpec {
  const [address, length, extra] = text.split(":");
  if (address === undefined || length === undefined || extra !== undefined || address.length === 0 || length.length === 0) {
    throw new Error(`Invalid dump '${text}'. Use ADDR:LENGTH.`);
  }
  return { address, length };
}

function printAssembly(assembled: AssembleSuccess, io: Io): void {
  const end = programEnd(assembled.program);
  writeLine(io.stdout, `OK: assembled ${end} bytes`);
  writeLine(io.stdout, "");
  writeLine(io.stdout, "ADDR  BYTES   INSTRUCTION");

  let pc = 0;
  while (pc < end) {
    const opcode = assembled.program[pc] ?? 0;
    const decoded = decodeOpcode(opcode);
    const length = Math.min(instructionLength(decoded), end - pc);
    const bytes = Array.from(assembled.program.slice(pc, pc + length));
    const instruction = disassemble(bytes, { startAddress: pc }).lines[0]?.replace(/^[0-9A-F]{2}H:\s*/, "") ?? "";
    writeLine(io.stdout, `${hexByte(pc).padEnd(5)} ${formatBytes(bytes).padEnd(7)} ${instruction}`);
    pc += length;
  }
}

function runProgram(assembled: AssembleSuccess, parsed: ParsedArgs, io: Io, trace: boolean): number {
  const cpu = new KueChip2(assembled.program);
  cpu.state.data.set(assembled.data);

  for (const assignment of parsed.data) {
    const address = resolveByte(assignment.address, assembled.symbols, "address");
    const value = resolveByte(assignment.value, assembled.symbols, "byte");
    cpu.state.data[address] = value;
  }

  const instructions: InstructionTrace[] = [];
  if (trace) writeLine(io.stdout, "PC    INSTRUCTION        ACC  IX   CF VF NF ZF");
  for (let i = 0; i < parsed.maxInstructions; i += 1) {
    if (cpu.state.trap || cpu.state.halt) break;
    const step = cpu.stepInstruction();
    instructions.push(step);
    if (trace) printTraceLine(step, io);
  }

  const stoppedReason = cpu.state.trap ? "trap" : cpu.state.halt ? "halt" : "max-instructions";
  if (trace) writeLine(io.stdout, "");
  printRunSummary(stoppedReason, instructions.length, cpu.state, parsed, assembled, io);

  return stoppedReason === "halt" ? 0 : 1;
}

function printTraceLine(step: InstructionTrace, io: Io): void {
  const program = step.phases[0]?.before.program ?? step.after.program;
  const instruction = instructionAt(program, step.pcBefore);
  writeLine(
    io.stdout,
    [
      hexByte(step.pcBefore).padEnd(5),
      instruction.padEnd(18),
      hexByte(step.after.acc).padEnd(4),
      hexByte(step.after.ix).padEnd(4),
      String(step.after.cf).padEnd(2),
      String(step.after.vf).padEnd(2),
      String(step.after.nf).padEnd(2),
      String(step.after.zf).padEnd(2),
    ].join(" "),
  );
}

function printRunSummary(
  stoppedReason: string,
  instructionCount: number,
  state: CpuSnapshot,
  parsed: ParsedArgs,
  assembled: AssembleSuccess,
  io: Io,
): void {
  writeLine(io.stdout, `STOPPED  ${stoppedReason}`);
  writeLine(io.stdout, `STEPS    ${instructionCount}`);
  if (state.trap !== undefined) writeLine(io.stdout, `TRAP     ${state.trap.message} at ${hexByte(state.trap.pc)}`);
  writeLine(io.stdout, "");
  writeLine(io.stdout, "REGISTERS");
  writeLine(io.stdout, `ACC  ${hexByte(state.acc)}`);
  writeLine(io.stdout, `IX   ${hexByte(state.ix)}`);
  writeLine(io.stdout, `PC   ${hexByte(state.pc)}`);
  writeLine(io.stdout, `CF   ${state.cf}`);
  writeLine(io.stdout, `VF   ${state.vf}`);
  writeLine(io.stdout, `NF   ${state.nf}`);
  writeLine(io.stdout, `ZF   ${state.zf}`);

  for (const dump of parsed.dumps) {
    const address = resolveByte(dump.address, assembled.symbols, "address");
    const length = resolveLength(dump.length, assembled.symbols);
    writeLine(io.stdout, "");
    writeLine(io.stdout, `DATA ${hexByte(address)}:${length}`);
    for (let offset = 0; offset < length; offset += 1) {
      const current = (address + offset) & 0xff;
      writeLine(io.stdout, `${hexByte(current)}  ${hexByte(state.data[current] ?? 0)}`);
    }
  }
}

function printDiagnostics(result: AssembleResult, io: Io): void {
  for (const diagnostic of result.diagnostics) {
    const location = diagnostic.line === undefined ? "" : `line ${diagnostic.line}: `;
    writeLine(io.stderr, `${diagnostic.severity}: ${location}${diagnostic.message}`);
  }
}

function instructionAt(program: Uint8Array, pc: number): string {
  const opcode = program[pc] ?? 0;
  const decoded = decodeOpcode(opcode);
  const length = instructionLength(decoded);
  const bytes = Array.from(program.slice(pc, pc + length));
  return disassemble(bytes, { startAddress: pc }).lines[0]?.replace(/^[0-9A-F]{2}H:\s*/, "") ?? "";
}

function resolveByte(text: string, symbols: ReadonlyMap<string, U8>, label: string): U8 {
  const value = resolveNumber(text, symbols);
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${label} '${text}' is outside 00H..FFH.`);
  }
  return value;
}

function resolveLength(text: string, symbols: ReadonlyMap<string, U8>): number {
  const value = resolveNumber(text, symbols);
  if (!Number.isInteger(value) || value <= 0 || value > 256) {
    throw new Error(`length '${text}' must be in 1..256.`);
  }
  return value;
}

function resolveNumber(text: string, symbols: ReadonlyMap<string, U8>): number {
  const trimmed = text.trim();
  if (symbols.has(trimmed)) return symbols.get(trimmed) ?? 0;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
  if (/^[0-9a-f]+h$/i.test(trimmed)) return Number.parseInt(trimmed.slice(0, -1), 16);
  if (/^0b[01]+$/i.test(trimmed)) return Number.parseInt(trimmed.slice(2), 2);
  if (/^[01]+b$/i.test(trimmed)) return Number.parseInt(trimmed.slice(0, -1), 2);
  throw new Error(`Unknown number or symbol '${text}'.`);
}

function programEnd(program: Uint8Array): number {
  for (let i = program.length - 1; i >= 0; i -= 1) {
    if (program[i] !== 0) return i + 1;
  }
  return 0;
}

function formatBytes(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function usage(): string {
  const name = basename(process.argv[1] ?? "kue-chip2");
  return [
    `Usage: ${name} <command> <file.asm> [options]`,
    "",
    "Commands:",
    "  assemble              Print address, bytes, and disassembled instructions",
    "  run                   Execute the program and print final state",
    "  trace                 Execute with one line per instruction",
    "",
    "Options:",
    "  --data ADDR=BYTE      Initialize one data-memory byte",
    "  --dump-data ADDR:LEN  Dump LEN bytes of data memory after execution",
    "  --max-instructions N  Stop after N instructions during run/trace",
  ].join("\n");
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, line: string): void {
  stream.write(`${line}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
