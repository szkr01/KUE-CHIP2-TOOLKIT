#!/usr/bin/env node

// src/cli.ts
import { readFileSync } from "fs";
import { basename } from "path";
import { pathToFileURL } from "url";

// src/isa/index.ts
var BRANCH_MNEMONICS = [
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
  "BLE"
];
var ALU_MNEMONICS = {
  8: "SBC",
  9: "ADC",
  10: "SUB",
  11: "ADD",
  12: "EOR",
  13: "OR",
  14: "AND",
  15: "CMP"
};
var SHIFT_ROTATE_MNEMONICS = {
  64: "SRA",
  65: "SLA",
  66: "SRL",
  67: "SLL",
  68: "RRA",
  69: "RLA",
  70: "RRL",
  71: "RLL"
};
function toU8(value) {
  return value & 255;
}
function toBit(value) {
  return value ? 1 : 0;
}
function bit7(value) {
  return (value & 128) !== 0 ? 1 : 0;
}
function zflag(value) {
  return (value & 255) === 0 ? 1 : 0;
}
function hexByte(value) {
  return `${toU8(value).toString(16).toUpperCase().padStart(2, "0")}H`;
}
function decodeOpcode(opcode) {
  const op = toU8(opcode);
  if ((op & 248) === 0) return { kind: "NOP", opcode: op };
  if ((op & 248) === 8) return { kind: "HLT", opcode: op };
  if ((op & 240) === 80) return { kind: "HLT", opcode: op };
  if ((op & 248) === 16) return { kind: "OUT", opcode: op };
  if ((op & 248) === 24) return { kind: "IN", opcode: op };
  if ((op & 248) === 32) return { kind: "RCF", opcode: op };
  if ((op & 248) === 40) return { kind: "SCF", opcode: op };
  if ((op & 240) === 48) return { kind: "Bcc", opcode: op, cc: op & 15 };
  if ((op & 240) === 64) {
    return {
      kind: "ShiftRotate",
      opcode: op,
      a: op >> 3 & 1,
      q: op >> 2 & 1,
      sm: op & 3
    };
  }
  const group = op >> 4 & 15;
  const a = op >> 3 & 1;
  const b = op & 7;
  if (group === 6) return { kind: "LD", opcode: op, a, b };
  if (group === 7) {
    if (b <= 3) {
      return { kind: "ILLEGAL", opcode: op, reason: "ST requires a memory operand" };
    }
    return { kind: "ST", opcode: op, a, b };
  }
  const alu = ALU_MNEMONICS[group];
  if (alu !== void 0) return { kind: alu, opcode: op, a, b };
  return { kind: "ILLEGAL", opcode: op, reason: "Undefined opcode" };
}
function instructionLength(decoded) {
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
function branchCond(cc, s) {
  switch (cc & 15) {
    case 0:
      return true;
    case 1:
      return s.zf === 0;
    case 2:
      return s.nf === 0;
    case 3:
      return (s.nf | s.zf) === 0;
    case 4:
      return s.ibufFlag === 0;
    case 5:
      return s.cf === 0;
    case 6:
      return (s.vf ^ s.nf) === 0;
    case 7:
      return (s.vf ^ s.nf | s.zf) === 0;
    case 8:
      return s.vf === 1;
    case 9:
      return s.zf === 1;
    case 10:
      return s.nf === 1;
    case 11:
      return (s.nf | s.zf) === 1;
    case 12:
      return s.obufFlag === 1;
    case 13:
      return s.cf === 1;
    case 14:
      return (s.vf ^ s.nf) === 1;
    case 15:
      return (s.vf ^ s.nf | s.zf) === 1;
    default:
      return false;
  }
}

// src/assembler/index.ts
var FIXED_OPCODES = {
  NOP: 0,
  HLT: 15,
  OUT: 16,
  IN: 24,
  RCF: 32,
  SCF: 40
};
var SHIFT_OPCODES = {
  SRA: { acc: 64, ix: 72 },
  SLA: { acc: 65, ix: 73 },
  SRL: { acc: 66, ix: 74 },
  SLL: { acc: 67, ix: 75 },
  RRA: { acc: 68, ix: 76 },
  RLA: { acc: 69, ix: 77 },
  RRL: { acc: 70, ix: 78 },
  RLL: { acc: 71, ix: 79 }
};
var GROUPS = {
  LD: 6,
  ST: 7,
  SBC: 8,
  ADC: 9,
  SUB: 10,
  ADD: 11,
  EOR: 12,
  OR: 13,
  AND: 14,
  CMP: 15
};
var BRANCH_CODES = new Map(BRANCH_MNEMONICS.map((mnemonic, index) => [mnemonic, index]));
function assemble(source) {
  const diagnostics = [];
  const statements = parseSource(source, diagnostics);
  const symbols = /* @__PURE__ */ new Map();
  pass1(statements, symbols, diagnostics);
  if (hasErrors(diagnostics)) {
    return { ok: false, diagnostics, symbols };
  }
  const program = new Uint8Array(256);
  const data = new Uint8Array(256);
  const initialized = {
    program: new Array(256).fill(false),
    data: new Array(256).fill(false)
  };
  pass2(statements, symbols, program, data, initialized, diagnostics);
  if (hasErrors(diagnostics)) {
    return { ok: false, diagnostics, symbols };
  }
  return { ok: true, program, data, diagnostics, symbols };
}
function parseSource(source, diagnostics) {
  const statements = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;
    const text = stripComment(raw).trim();
    if (text.length === 0) continue;
    let rest = text;
    const labels = [];
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
function stripComment(raw) {
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
function splitArgs(text) {
  const args = [];
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
function pass1(statements, symbols, diagnostics) {
  const loc = { section: "program", program: 0, data: 0 };
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
    if (op === void 0) continue;
    handleLocationDirective(statement, loc, symbols, diagnostics, true);
  }
}
function pass2(statements, symbols, program, data, initialized, diagnostics) {
  const loc = { section: "program", program: 0, data: 0 };
  for (const statement of statements) {
    const op = statement.op;
    if (op === void 0) continue;
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
function handleLocationDirective(statement, loc, symbols, diagnostics, sizingOnly) {
  const op = statement.op;
  if (op === void 0) return false;
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
function instructionSize(statement, diagnostics) {
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
function encodeInstruction(statement, symbols, diagnostics) {
  const op = statement.op ?? "";
  if (op in FIXED_OPCODES) {
    if (statement.args.length !== 0) diagnostics.push({ severity: "error", line: statement.line, message: `${op} takes no operands` });
    return [FIXED_OPCODES[op] ?? 0];
  }
  const shift = SHIFT_OPCODES[op];
  if (shift !== void 0) {
    if (statement.args.length !== 1) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} requires ACC or IX` });
      return [shift.acc];
    }
    const reg = parseRegister(statement.args[0] ?? "");
    if (reg === void 0) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} target must be ACC or IX` });
      return [shift.acc];
    }
    return [reg === 0 ? shift.acc : shift.ix];
  }
  const branch = BRANCH_CODES.get(op);
  if (branch !== void 0) {
    if (statement.args.length !== 1) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} requires one target` });
      return [48 | branch, 0];
    }
    return [48 | branch, evalExpr(statement.args[0] ?? "", symbols, diagnostics, statement.line)];
  }
  const group = GROUPS[op];
  if (group !== void 0) {
    if (statement.args.length !== 2) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} requires two operands` });
      return [group << 4 & 255];
    }
    const dst = parseRegister(statement.args[0] ?? "");
    if (dst === void 0) {
      diagnostics.push({ severity: "error", line: statement.line, message: `${op} destination must be ACC or IX` });
      return [group << 4 & 255];
    }
    const src = parseOperand(statement.args[1] ?? "", diagnostics, statement.line);
    const b = operandSelector(src, op, diagnostics, statement.line);
    const opcode = (group << 4 | dst << 3 | b) & 255;
    if (src.kind === "reg") return [opcode];
    return [opcode, evalExpr(src.expr, symbols, diagnostics, statement.line)];
  }
  diagnostics.push({ severity: "error", line: statement.line, message: `Unknown operation '${op}'` });
  return [];
}
function parseOperand(text, diagnostics, line) {
  const reg = parseRegister(text);
  if (reg !== void 0) return { kind: "reg", reg };
  const trimmed = text.trim();
  const programMatch = /^\[(.*)\]$/.exec(trimmed);
  if (programMatch !== null) return parseMemory(programMatch[1] ?? "", 4, 6);
  const dataMatch = /^\((.*)\)$/.exec(trimmed);
  if (dataMatch !== null) return parseMemory(dataMatch[1] ?? "", 5, 7);
  return { kind: "imm", expr: trimmed };
  function parseMemory(innerRaw, absolute, indexed) {
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
function operandSelector(operand, op, diagnostics, line) {
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
function parseRegister(text) {
  const normalized = text.trim().toUpperCase();
  if (normalized === "ACC") return 0;
  if (normalized === "IX") return 1;
  return void 0;
}
function evalExpr(expr, symbols, diagnostics, line) {
  const trimmed = expr.trim();
  const value = evalAddSubExpr(trimmed, symbols);
  if (value === void 0 || Number.isNaN(value)) {
    diagnostics.push({ severity: "error", line, message: `Unknown expression '${expr}'` });
    return 0;
  }
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    diagnostics.push({ severity: "error", line, message: `Value '${expr}' is outside 8-bit range` });
    return toU8(value);
  }
  return value;
}
function evalAddSubExpr(expr, symbols) {
  if (expr.length === 0) return void 0;
  let value;
  let op = "+";
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
      if (inChar || ch !== "+" && ch !== "-") continue;
    }
    const term = expr.slice(termStart, i).trim();
    const termValue = evalExprTerm(term, symbols);
    if (termValue === void 0) return void 0;
    value = value === void 0 ? termValue : op === "+" ? value + termValue : value - termValue;
    if (i < expr.length) {
      op = ch;
      termStart = i + 1;
    }
  }
  if (inChar || escaped) return void 0;
  return value;
}
function evalExprTerm(term, symbols) {
  const trimmed = term.trim();
  let value;
  if (/^\d+$/.test(trimmed)) value = Number.parseInt(trimmed, 10);
  else if (/^0x[0-9a-f]+$/i.test(trimmed)) value = Number.parseInt(trimmed.slice(2), 16);
  else if (/^[0-9a-f]+h$/i.test(trimmed)) value = Number.parseInt(trimmed.slice(0, -1), 16);
  else if (/^0b[01]+$/i.test(trimmed)) value = Number.parseInt(trimmed.slice(2), 2);
  else if (/^[01]+b$/i.test(trimmed)) value = Number.parseInt(trimmed.slice(0, -1), 2);
  else if (/^'(?:\\.|[^\\'])'$/.test(trimmed)) value = charValue(trimmed);
  else if (symbols.has(trimmed)) value = symbols.get(trimmed);
  return value;
}
function charValue(text) {
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
function defineSymbol(name, value, symbols, diagnostics, line) {
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
function currentAddress(loc) {
  return loc.section === "program" ? loc.program : loc.data;
}
function setCurrentAddress(loc, address) {
  if (loc.section === "program") loc.program = address;
  else loc.data = address;
}
function advance(loc, amount, diagnostics, line) {
  const next = currentAddress(loc) + amount;
  if (next > 256) diagnostics.push({ severity: "error", line, message: `${loc.section} location counter exceeds 256 bytes` });
  setCurrentAddress(loc, next);
}
function emitByte(section, address, value, program, data, initialized, diagnostics, line) {
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
function hasErrors(diagnostics) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

// src/disassembler/index.ts
function disassemble(bytes, options = {}) {
  const lines = [];
  const startAddress = options.startAddress ?? 0;
  let i = 0;
  while (i < bytes.length) {
    const address = startAddress + i & 255;
    const opcode = (bytes[i] ?? 0) & 255;
    const decoded = decodeOpcode(opcode);
    const length = instructionLength(decoded);
    const operand = length === 2 ? bytes[i + 1] : void 0;
    if (length === 2 && operand === void 0) {
      lines.push(`${hexByte(address)}: .db ${hexByte(opcode)} ; truncated`);
      i += 1;
      continue;
    }
    lines.push(`${hexByte(address)}: ${formatInstruction(decoded, operand)}`);
    i += length;
  }
  return { ok: true, lines, text: lines.join("\n") };
}
function formatInstruction(decoded, operand) {
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
      const baseOpcode = 64 | decoded.opcode & 7;
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
function formatOperand(selector, operand) {
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

// src/emulator/alu.ts
function executeAlu(kind, lhs, rhs, cf) {
  switch (kind) {
    case "ADC": {
      const wide = lhs + rhs + cf;
      const result = toU8(wide);
      return {
        result,
        cf: toBit(wide > 255),
        vf: toBit(((lhs ^ result) & (rhs ^ result) & 128) !== 0),
        nf: bit7(result),
        zf: zflag(result)
      };
    }
    case "ADD": {
      const result = toU8(lhs + rhs);
      return {
        result,
        vf: toBit(((lhs ^ result) & (rhs ^ result) & 128) !== 0),
        nf: bit7(result),
        zf: zflag(result)
      };
    }
    case "SBC": {
      const wide = lhs - rhs - cf;
      const result = toU8(wide);
      const subtrahend = toU8(rhs + cf);
      return {
        result,
        cf: toBit(wide < 0),
        vf: toBit(((lhs ^ subtrahend) & (lhs ^ result) & 128) !== 0),
        nf: bit7(result),
        zf: zflag(result)
      };
    }
    case "SUB":
    case "CMP": {
      const result = toU8(lhs - rhs);
      return {
        result,
        vf: toBit(((lhs ^ rhs) & (lhs ^ result) & 128) !== 0),
        nf: bit7(result),
        zf: zflag(result)
      };
    }
    case "EOR": {
      const result = toU8(lhs ^ rhs);
      return { result, vf: 0, nf: bit7(result), zf: zflag(result) };
    }
    case "OR": {
      const result = toU8(lhs | rhs);
      return { result, vf: 0, nf: bit7(result), zf: zflag(result) };
    }
    case "AND": {
      const result = toU8(lhs & rhs);
      return { result, vf: 0, nf: bit7(result), zf: zflag(result) };
    }
  }
}

// src/emulator/KueChip2.ts
function createInitialCpuState() {
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
    phase: 0
  };
}
function snapshotState(state) {
  return {
    ...state,
    program: new Uint8Array(state.program),
    data: new Uint8Array(state.data)
  };
}
var KueChip2 = class {
  constructor(program) {
    this.state = createInitialCpuState();
    if (program !== void 0) this.loadProgram(program);
  }
  reset() {
    const program = new Uint8Array(this.state.program);
    const data = new Uint8Array(this.state.data);
    this.state = createInitialCpuState();
    this.state.program.set(program);
    this.state.data.set(data);
    this.pendingShiftFlags = void 0;
  }
  loadProgram(bytes, offset = 0) {
    this.loadBytes(this.state.program, bytes, offset);
  }
  loadData(bytes, offset = 0) {
    this.loadBytes(this.state.data, bytes, offset);
  }
  stepPhase() {
    const phase = this.state.phase;
    const before = snapshotState(this.state);
    this.executePhase(phase);
    return { phase, before, after: snapshotState(this.state) };
  }
  stepInstruction() {
    const pcBefore = this.state.pc;
    const phases = [];
    if (this.state.halt || this.state.trap) {
      return {
        pcBefore,
        irAfterFetch: this.state.ir,
        pcAfter: this.state.pc,
        phases,
        after: snapshotState(this.state),
        ...this.state.trap ? { trap: this.state.trap } : {}
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
      ...this.state.trap ? { trap: this.state.trap } : {}
    };
  }
  run(maxInstructions = 1e4) {
    const instructions = [];
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
  setInput(value) {
    this.state.ibuf = toU8(value);
    this.state.ibufFlag = 1;
  }
  readOutput() {
    return this.state.obuf;
  }
  clearOutputFlag() {
    this.state.obufFlag = 0;
  }
  loadBytes(target, bytes, offset) {
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
  executePhase(phase) {
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
  executeP2() {
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
          this.setRegister(decoded.a, this.getRegister(decoded.b));
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
          this.executeAluOnRegister(decoded.kind, decoded.a, this.getRegister(decoded.b));
          this.finishInstruction();
        } else {
          this.fetchOperandByte();
          this.state.phase = 3;
        }
        return;
    }
  }
  executeP3() {
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
        if (this.pendingShiftFlags === void 0) {
          this.trapInternal("Missing shift flags");
          return;
        }
        this.state.cf = this.pendingShiftFlags.cf;
        this.state.vf = this.pendingShiftFlags.vf;
        this.state.nf = this.pendingShiftFlags.nf;
        this.state.zf = this.pendingShiftFlags.zf;
        this.pendingShiftFlags = void 0;
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
  executeP4() {
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
  fetchOperandByte() {
    this.state.mar = this.state.pc;
    this.state.pc = toU8(this.state.pc + 1);
  }
  resolveMemoryAddress(b) {
    const displacement = this.state.program[this.state.mar] ?? 0;
    this.state.mar = b >= 6 ? toU8(this.state.ix + displacement) : displacement;
  }
  readMemoryOperand(b) {
    return b === 4 || b === 6 ? this.state.program[this.state.mar] ?? 0 : this.state.data[this.state.mar] ?? 0;
  }
  writeMemoryOperand(b, value) {
    if (b === 4 || b === 6) this.state.program[this.state.mar] = toU8(value);
    else this.state.data[this.state.mar] = toU8(value);
  }
  executeAluOnRegister(kind, a, rhs) {
    const lhs = this.getRegister(a);
    const result = executeAlu(kind, lhs, rhs, this.state.cf);
    if (kind !== "CMP") this.setRegister(a, result.result);
    if (result.cf !== void 0) this.state.cf = result.cf;
    this.state.vf = result.vf;
    this.state.nf = result.nf;
    this.state.zf = result.zf;
  }
  executeShiftRotate(decoded) {
    const old = this.getRegister(decoded.a);
    let result;
    let cf;
    let vf;
    const op = decoded.opcode & 71;
    switch (op & 7) {
      case 0:
        result = toU8(old & 128 | old >> 1);
        cf = toBit(old & 1);
        vf = 0;
        break;
      case 1:
        result = toU8(old << 1);
        cf = bit7(old);
        vf = toBit(bit7(old) ^ bit7(result));
        break;
      case 2:
        result = toU8(old >> 1);
        cf = toBit(old & 1);
        vf = 0;
        break;
      case 3:
        result = toU8(old << 1);
        cf = bit7(old);
        vf = 0;
        break;
      case 4:
        result = toU8(this.state.cf << 7 | old >> 1);
        cf = toBit(old & 1);
        vf = 0;
        break;
      case 5:
        result = toU8(old << 1 | this.state.cf);
        cf = bit7(old);
        vf = toBit(bit7(old) ^ bit7(result));
        break;
      case 6:
        result = toU8(old >> 1 | (old & 1) << 7);
        cf = toBit(old & 1);
        vf = 0;
        break;
      case 7:
        result = toU8(old << 1 | old >> 7 & 1);
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
  getRegister(selector) {
    return selector === 0 ? this.state.acc : this.state.ix;
  }
  setRegister(selector, value) {
    if (selector === 0) this.state.acc = toU8(value);
    else this.state.ix = toU8(value);
  }
  decoded() {
    if (this.state.decoded !== void 0) return this.state.decoded;
    const decoded = decodeOpcode(this.state.ir);
    this.state.decoded = decoded;
    return decoded;
  }
  finishInstruction() {
    this.state.phase = 0;
  }
  trapIllegal(decoded) {
    const trap = {
      kind: "illegal-instruction",
      opcode: decoded.opcode,
      pc: toU8(this.state.pc - 1),
      message: decoded.reason
    };
    this.state.trap = trap;
    this.state.halt = true;
    this.finishInstruction();
  }
  trapInternal(message) {
    this.state.trap = {
      kind: "illegal-instruction",
      opcode: this.state.ir,
      pc: toU8(this.state.pc - 1),
      message
    };
    this.state.halt = true;
    this.finishInstruction();
  }
};

// src/cli.ts
var DEFAULT_MAX_INSTRUCTIONS = 1e4;
function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let parsed;
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
  if (parsed.help || parsed.command === void 0) {
    writeLine(io.stdout, usage());
    return 0;
  }
  if (parsed.file === void 0) {
    writeLine(io.stderr, `Missing ASM file for '${parsed.command}'.`);
    return 1;
  }
  let source;
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
function parseArgs(argv) {
  const parsed = {
    command: void 0,
    file: void 0,
    data: [],
    dumps: [],
    maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
    help: false
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--data": {
        const value = argv[++i];
        if (value === void 0) return "--data requires ADDR=BYTE.";
        parsed.data.push(parseAssignment(value));
        break;
      }
      case "--dump-data": {
        const value = argv[++i];
        if (value === void 0) return "--dump-data requires ADDR:LENGTH.";
        parsed.dumps.push(parseDumpSpec(value));
        break;
      }
      case "--max-instructions": {
        const value = argv[++i];
        if (value === void 0) return "--max-instructions requires a number.";
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
function parseAssignment(text) {
  const [address, value, extra] = text.split("=");
  if (address === void 0 || value === void 0 || extra !== void 0 || address.length === 0 || value.length === 0) {
    throw new Error(`Invalid assignment '${text}'. Use ADDR=BYTE.`);
  }
  return { address, value };
}
function parseDumpSpec(text) {
  const [address, length, extra] = text.split(":");
  if (address === void 0 || length === void 0 || extra !== void 0 || address.length === 0 || length.length === 0) {
    throw new Error(`Invalid dump '${text}'. Use ADDR:LENGTH.`);
  }
  return { address, length };
}
function printAssembly(assembled, io) {
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
function runProgram(assembled, parsed, io, trace) {
  const cpu = new KueChip2(assembled.program);
  cpu.state.data.set(assembled.data);
  for (const assignment of parsed.data) {
    const address = resolveByte(assignment.address, assembled.symbols, "address");
    const value = resolveByte(assignment.value, assembled.symbols, "byte");
    cpu.state.data[address] = value;
  }
  const instructions = [];
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
function printTraceLine(step, io) {
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
      String(step.after.zf).padEnd(2)
    ].join(" ")
  );
}
function printRunSummary(stoppedReason, instructionCount, state, parsed, assembled, io) {
  writeLine(io.stdout, `STOPPED  ${stoppedReason}`);
  writeLine(io.stdout, `STEPS    ${instructionCount}`);
  if (state.trap !== void 0) writeLine(io.stdout, `TRAP     ${state.trap.message} at ${hexByte(state.trap.pc)}`);
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
      const current = address + offset & 255;
      writeLine(io.stdout, `${hexByte(current)}  ${hexByte(state.data[current] ?? 0)}`);
    }
  }
}
function printDiagnostics(result, io) {
  for (const diagnostic of result.diagnostics) {
    const location = diagnostic.line === void 0 ? "" : `line ${diagnostic.line}: `;
    writeLine(io.stderr, `${diagnostic.severity}: ${location}${diagnostic.message}`);
  }
}
function instructionAt(program, pc) {
  const opcode = program[pc] ?? 0;
  const decoded = decodeOpcode(opcode);
  const length = instructionLength(decoded);
  const bytes = Array.from(program.slice(pc, pc + length));
  return disassemble(bytes, { startAddress: pc }).lines[0]?.replace(/^[0-9A-F]{2}H:\s*/, "") ?? "";
}
function resolveByte(text, symbols, label) {
  const value = resolveNumber(text, symbols);
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${label} '${text}' is outside 00H..FFH.`);
  }
  return value;
}
function resolveLength(text, symbols) {
  const value = resolveNumber(text, symbols);
  if (!Number.isInteger(value) || value <= 0 || value > 256) {
    throw new Error(`length '${text}' must be in 1..256.`);
  }
  return value;
}
function resolveNumber(text, symbols) {
  const trimmed = text.trim();
  if (symbols.has(trimmed)) return symbols.get(trimmed) ?? 0;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
  if (/^[0-9a-f]+h$/i.test(trimmed)) return Number.parseInt(trimmed.slice(0, -1), 16);
  if (/^0b[01]+$/i.test(trimmed)) return Number.parseInt(trimmed.slice(2), 2);
  if (/^[01]+b$/i.test(trimmed)) return Number.parseInt(trimmed.slice(0, -1), 2);
  throw new Error(`Unknown number or symbol '${text}'.`);
}
function programEnd(program) {
  for (let i = program.length - 1; i >= 0; i -= 1) {
    if (program[i] !== 0) return i + 1;
  }
  return 0;
}
function formatBytes(bytes) {
  return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}
function usage() {
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
    "  --max-instructions N  Stop after N instructions during run/trace"
  ].join("\n");
}
function writeLine(stream, line) {
  stream.write(`${line}
`);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
if (process.argv[1] !== void 0 && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
export {
  runCli
};
