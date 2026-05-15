import { BRANCH_MNEMONICS, toU8 } from "../isa/index.js";
import type { AssembleResult, Diagnostic, OperandSelector, Section, U8 } from "../types.js";

type LineStatement = {
  line: number;
  labels: string[];
  op?: string;
  args: string[];
};

type Location = {
  section: Section;
  program: number;
  data: number;
};

type ParsedOperand =
  | { kind: "reg"; reg: 0 | 1 }
  | { kind: "imm"; expr: string }
  | { kind: "mem"; mode: 4 | 5 | 6 | 7; expr: string };

const FIXED_OPCODES: Record<string, number> = {
  NOP: 0x00,
  HLT: 0x0f,
  OUT: 0x10,
  IN: 0x18,
  RCF: 0x20,
  SCF: 0x28,
};

const SHIFT_OPCODES: Record<string, { acc: number; ix: number }> = {
  SRA: { acc: 0x40, ix: 0x48 },
  SLA: { acc: 0x41, ix: 0x49 },
  SRL: { acc: 0x42, ix: 0x4a },
  SLL: { acc: 0x43, ix: 0x4b },
  RRA: { acc: 0x44, ix: 0x4c },
  RLA: { acc: 0x45, ix: 0x4d },
  RRL: { acc: 0x46, ix: 0x4e },
  RLL: { acc: 0x47, ix: 0x4f },
};

const GROUPS: Record<string, number> = {
  LD: 0x6,
  ST: 0x7,
  SBC: 0x8,
  ADC: 0x9,
  SUB: 0xa,
  ADD: 0xb,
  EOR: 0xc,
  OR: 0xd,
  AND: 0xe,
  CMP: 0xf,
};

const BRANCH_CODES = new Map<string, number>(BRANCH_MNEMONICS.map((mnemonic, index) => [mnemonic, index]));

export function assemble(source: string): AssembleResult {
  const diagnostics: Diagnostic[] = [];
  const statements = parseSource(source, diagnostics);
  const symbols = new Map<string, U8>();
  pass1(statements, symbols, diagnostics);

  if (hasErrors(diagnostics)) {
    return { ok: false, diagnostics, symbols };
  }

  const program = new Uint8Array(256);
  const data = new Uint8Array(256);
  const initialized = {
    program: new Array<boolean>(256).fill(false),
    data: new Array<boolean>(256).fill(false),
  };
  pass2(statements, symbols, program, data, initialized, diagnostics);

  if (hasErrors(diagnostics)) {
    return { ok: false, diagnostics, symbols };
  }
  return { ok: true, program, data, diagnostics, symbols };
}

function parseSource(source: string, diagnostics: Diagnostic[]): LineStatement[] {
  const statements: LineStatement[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;
    const text = stripComment(raw).trim();
    if (text.length === 0) continue;

    let rest = text;
    const labels: string[] = [];
    while (true) {
      const match = /^([A-Za-z_.$][\w.$]*):\s*(.*)$/.exec(rest);
      if (match === null) break;
      labels.push(match[1] ?? "");
      rest = (match[2] ?? "").trim();
      if (rest.length === 0) break;
    }

    if (rest.length === 0) {
      statements.push({ line: lineNo, labels, args: [] });
      continue;
    }

    const opMatch = /^(\S+)(?:\s+(.*))?$/.exec(rest);
    if (opMatch === null) {
      diagnostics.push({ severity: "error", line: lineNo, message: "Cannot parse line" });
      continue;
    }
    const op = (opMatch[1] ?? "").toUpperCase();
    const argsText = opMatch[2]?.trim() ?? "";
    const args = argsText.length === 0 ? [] : splitArgs(argsText);
    statements.push({ line: lineNo, labels, op, args });
  }
  return statements;
}

function stripComment(raw: string): string {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("*")) return "";
  let inChar = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") inChar = !inChar;
    if (ch === ";" && !inChar) return raw.slice(0, i);
  }
  return raw;
}

function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let inChar = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'") {
      current += ch;
      inChar = !inChar;
      continue;
    }
    if (!inChar && (ch === "[" || ch === "(")) depth += 1;
    if (!inChar && (ch === "]" || ch === ")")) depth -= 1;
    if (ch === "," && depth === 0 && !inChar) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

function pass1(statements: LineStatement[], symbols: Map<string, U8>, diagnostics: Diagnostic[]): void {
  const loc: Location = { section: "program", program: 0, data: 0 };
  for (const statement of statements) {
    const op = statement.op;
    if (op === "END") break;

    if (op === "EQU" && statement.labels.length > 0) {
      if (statement.args.length !== 1) {
        diagnostics.push({ severity: "error", line: statement.line, message: "EQU requires one value" });
      } else {
        defineSymbol(statement.labels[0] ?? "", evalExpr(statement.args[0] ?? "", symbols, diagnostics, statement.line), symbols, diagnostics, statement.line);
      }
      continue;
    }

    for (const label of statement.labels) {
      defineSymbol(label, currentAddress(loc), symbols, diagnostics, statement.line);
    }

    if (op === undefined) continue;
    handleLocationDirective(statement, loc, symbols, diagnostics, true);
  }
}

function pass2(
  statements: LineStatement[],
  symbols: Map<string, U8>,
  program: Uint8Array,
  data: Uint8Array,
  initialized: { program: boolean[]; data: boolean[] },
  diagnostics: Diagnostic[],
): void {
  const loc: Location = { section: "program", program: 0, data: 0 };
  for (const statement of statements) {
    const op = statement.op;
    if (op === undefined) continue;
    if (op === "END") break;
    if (op === "EQU") continue;
    if (handleLocationDirective(statement, loc, symbols, diagnostics, false)) continue;

    if (op === ".BYTE" || op === ".DB") {
      for (const arg of statement.args) {
        const value = evalExpr(arg, symbols, diagnostics, statement.line);
        emitByte(loc.section, currentAddress(loc), value, program, data, initialized, diagnostics, statement.line);
        advance(loc, 1, diagnostics, statement.line);
      }
      continue;
    }

    if (loc.section !== "program") {
      diagnostics.push({ severity: "error", line: statement.line, message: "Instructions must be emitted in the program section" });
      continue;
    }

    const encoded = encodeInstruction(statement, symbols, diagnostics);
    for (const byte of encoded) {
      emitByte("program", loc.program, byte, program, data, initialized, diagnostics, statement.line);
      advance(loc, 1, diagnostics, statement.line);
    }
  }
}

function handleLocationDirective(
  statement: LineStatement,
  loc: Location,
  symbols: Map<string, U8>,
  diagnostics: Diagnostic[],
  sizingOnly: boolean,
): boolean {
  const op = statement.op;
  if (op === undefined) return false;
  if (op === ".ORG") {
    if (statement.args.length !== 1) diagnostics.push({ severity: "error", line: statement.line, message: ".org requires one address" });
    else setCurrentAddress(loc, evalExpr(statement.args[0] ?? "", symbols, diagnostics, statement.line));
    return true;
  }
  if (op === ".PROGRAM") {
    loc.section = "program";
    if (statement.args.length > 0) loc.program = evalExpr(statement.args[0] ?? "", symbols, diagnostics, statement.line);
    return true;
  }
  if (op === ".DATA") {
    loc.section = "data";
    if (statement.args.length > 0) loc.data = evalExpr(statement.args[0] ?? "", symbols, diagnostics, statement.line);
    return true;
  }
  if (op === ".EQU") {
    if (statement.args.length !== 2) {
      diagnostics.push({ severity: "error", line: statement.line, message: ".equ requires name and value" });
    } else if (sizingOnly) {
      defineSymbol(statement.args[0] ?? "", evalExpr(statement.args[1] ?? "", symbols, diagnostics, statement.line), symbols, diagnostics, statement.line);
    }
    return true;
  }
  if (op === ".BYTE" || op === ".DB") {
    if (sizingOnly) advance(loc, statement.args.length, diagnostics, statement.line);
    return sizingOnly;
  }
  if (op in FIXED_OPCODES || op in SHIFT_OPCODES || op in GROUPS || BRANCH_CODES.has(op)) {
    if (sizingOnly) advance(loc, instructionSize(statement, diagnostics), diagnostics, statement.line);
    return sizingOnly;
  }
  diagnostics.push({ severity: "error", line: statement.line, message: `Unknown operation '${op ?? ""}'` });
  return true;
}

function instructionSize(statement: LineStatement, diagnostics: Diagnostic[]): number {
  const op = statement.op ?? "";
  if (op in FIXED_OPCODES || op in SHIFT_OPCODES) return 1;
  if (BRANCH_CODES.has(op)) return 2;
  if (op in GROUPS) {
    if (statement.args.length !== 2) return 1;
    const operand = parseOperand(statement.args[1] ?? "", diagnostics, statement.line);
    return operand.kind === "reg" ? 1 : 2;
  }
  return 0;
}

function encodeInstruction(statement: LineStatement, symbols: Map<string, U8>, diagnostics: Diagnostic[]): U8[] {
  const op = statement.op ?? "";
  if (op in FIXED_OPCODES) {
    if (statement.args.length !== 0) diagnostics.push({ severity: "error", line: statement.line, message: `${op} takes no operands` });
    return [FIXED_OPCODES[op] ?? 0];
  }

  const shift = SHIFT_OPCODES[op];
  if (shift !== undefined) {
    if (statement.args.length !== 1) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} requires ACC or IX` });
      return [shift.acc];
    }
    const reg = parseRegister(statement.args[0] ?? "");
    if (reg === undefined) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} target must be ACC or IX` });
      return [shift.acc];
    }
    return [reg === 0 ? shift.acc : shift.ix];
  }

  const branch = BRANCH_CODES.get(op);
  if (branch !== undefined) {
    if (statement.args.length !== 1) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} requires one target` });
      return [0x30 | branch, 0];
    }
    return [0x30 | branch, evalExpr(statement.args[0] ?? "", symbols, diagnostics, statement.line)];
  }

  const group = GROUPS[op];
  if (group !== undefined) {
    if (statement.args.length !== 2) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} requires two operands` });
      return [(group << 4) & 0xff];
    }
    const dst = parseRegister(statement.args[0] ?? "");
    if (dst === undefined) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} destination must be ACC or IX` });
      return [(group << 4) & 0xff];
    }
    const src = parseOperand(statement.args[1] ?? "", diagnostics, statement.line);
    const b = operandSelector(src, op, diagnostics, statement.line);
    const opcode = ((group << 4) | (dst << 3) | b) & 0xff;
    if (src.kind === "reg") return [opcode];
    return [opcode, evalExpr(src.expr, symbols, diagnostics, statement.line)];
  }

  diagnostics.push({ severity: "error", line: statement.line, message: `Unknown operation '${op}'` });
  return [];
}

function parseOperand(text: string, diagnostics: Diagnostic[], line: number): ParsedOperand {
  const reg = parseRegister(text);
  if (reg !== undefined) return { kind: "reg", reg };

  const trimmed = text.trim();
  const programMatch = /^\[(.*)\]$/.exec(trimmed);
  if (programMatch !== null) return parseMemory(programMatch[1] ?? "", 4, 6);
  const dataMatch = /^\((.*)\)$/.exec(trimmed);
  if (dataMatch !== null) return parseMemory(dataMatch[1] ?? "", 5, 7);
  return { kind: "imm", expr: trimmed };

  function parseMemory(innerRaw: string, absolute: 4 | 5, indexed: 6 | 7): ParsedOperand {
    const inner = innerRaw.trim();
    if (/^IX$/i.test(inner)) return { kind: "mem", mode: indexed, expr: "0" };
    const indexedMatch = /^IX\s*\+\s*(.+)$/i.exec(inner);
    if (indexedMatch !== null) return { kind: "mem", mode: indexed, expr: (indexedMatch[1] ?? "").trim() };
    if (/^IX\s*-/.test(inner.toUpperCase())) {
      diagnostics.push({ severity: "error", line, message: "Negative indexed displacements are not supported; use an 8-bit wrapped value" });
      return { kind: "mem", mode: indexed, expr: "0" };
    }
    return { kind: "mem", mode: absolute, expr: inner };
  }
}

function operandSelector(operand: ParsedOperand, op: string, diagnostics: Diagnostic[], line: number): OperandSelector {
  if (operand.kind === "reg") {
    if (op === "ST") diagnostics.push({ severity: "error", line, message: "ST requires a memory operand" });
    return operand.reg;
  }
  if (operand.kind === "imm") {
    if (op === "ST") diagnostics.push({ severity: "error", line, message: "ST cannot store to an immediate operand" });
    return 2;
  }
  return operand.mode;
}

function parseRegister(text: string): 0 | 1 | undefined {
  const normalized = text.trim().toUpperCase();
  if (normalized === "ACC") return 0;
  if (normalized === "IX") return 1;
  return undefined;
}

function evalExpr(expr: string, symbols: Map<string, U8>, diagnostics: Diagnostic[], line: number): U8 {
  const trimmed = expr.trim();
  const value = evalAddSubExpr(trimmed, symbols);

  if (value === undefined || Number.isNaN(value)) {
    diagnostics.push({ severity: "error", line, message: `Unknown expression '${expr}'` });
    return 0;
  }
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    diagnostics.push({ severity: "error", line, message: `Value '${expr}' is outside 8-bit range` });
    return toU8(value);
  }
  return value;
}

function evalAddSubExpr(expr: string, symbols: Map<string, U8>): number | undefined {
  if (expr.length === 0) return undefined;

  let value: number | undefined;
  let op: "+" | "-" = "+";
  let termStart = 0;
  let inChar = false;
  let escaped = false;

  for (let i = 0; i <= expr.length; i += 1) {
    const ch = expr[i];
    if (i < expr.length) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "'") {
        inChar = !inChar;
        continue;
      }
      if (inChar || (ch !== "+" && ch !== "-")) continue;
    }

    const term = expr.slice(termStart, i).trim();
    const termValue = evalExprTerm(term, symbols);
    if (termValue === undefined) return undefined;
    value = value === undefined ? termValue : op === "+" ? value + termValue : value - termValue;

    if (i < expr.length) {
      op = ch as "+" | "-";
      termStart = i + 1;
    }
  }

  if (inChar || escaped) return undefined;
  return value;
}

function evalExprTerm(term: string, symbols: Map<string, U8>): number | undefined {
  const trimmed = term.trim();
  let value: number | undefined;
  if (/^\d+$/.test(trimmed)) value = Number.parseInt(trimmed, 10);
  else if (/^0x[0-9a-f]+$/i.test(trimmed)) value = Number.parseInt(trimmed.slice(2), 16);
  else if (/^[0-9a-f]+h$/i.test(trimmed)) value = Number.parseInt(trimmed.slice(0, -1), 16);
  else if (/^0b[01]+$/i.test(trimmed)) value = Number.parseInt(trimmed.slice(2), 2);
  else if (/^[01]+b$/i.test(trimmed)) value = Number.parseInt(trimmed.slice(0, -1), 2);
  else if (/^'(?:\\.|[^\\'])'$/.test(trimmed)) value = charValue(trimmed);
  else if (symbols.has(trimmed)) value = symbols.get(trimmed);

  return value;
}

function charValue(text: string): number {
  const body = text.slice(1, -1);
  if (!body.startsWith("\\")) return body.charCodeAt(0);
  switch (body[1]) {
    case "n":
      return 10;
    case "r":
      return 13;
    case "t":
      return 9;
    case "0":
      return 0;
    case "\\":
      return 92;
    case "'":
      return 39;
    default:
      return body.charCodeAt(1);
  }
}

function defineSymbol(
  name: string,
  value: U8,
  symbols: Map<string, U8>,
  diagnostics: Diagnostic[],
  line: number,
): void {
  if (!/^[A-Za-z_.$][\w.$]*$/.test(name)) {
    diagnostics.push({ severity: "error", line, message: `Invalid symbol name '${name}'` });
    return;
  }
  if (symbols.has(name)) {
    diagnostics.push({ severity: "error", line, message: `Duplicate symbol '${name}'` });
    return;
  }
  symbols.set(name, value);
}

function currentAddress(loc: Location): number {
  return loc.section === "program" ? loc.program : loc.data;
}

function setCurrentAddress(loc: Location, address: number): void {
  if (loc.section === "program") loc.program = address;
  else loc.data = address;
}

function advance(loc: Location, amount: number, diagnostics: Diagnostic[], line: number): void {
  const next = currentAddress(loc) + amount;
  if (next > 256) diagnostics.push({ severity: "error", line, message: `${loc.section} location counter exceeds 256 bytes` });
  setCurrentAddress(loc, next);
}

function emitByte(
  section: Section,
  address: number,
  value: U8,
  program: Uint8Array,
  data: Uint8Array,
  initialized: { program: boolean[]; data: boolean[] },
  diagnostics: Diagnostic[],
  line: number,
): void {
  if (address < 0 || address > 255) {
    diagnostics.push({ severity: "error", line, message: `${section} address ${address} is outside 8-bit range` });
    return;
  }
  if (initialized[section][address]) {
    diagnostics.push({ severity: "error", line, message: `${section} address ${address.toString(16).toUpperCase()}H is already initialized` });
    return;
  }
  initialized[section][address] = true;
  if (section === "program") program[address] = value;
  else data[address] = value;
}

function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
