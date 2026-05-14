import { describe, expect, it } from "vitest";
import { assemble, decodeOpcode, disassemble, KueChip2 } from "../src/index.js";

function mustAssemble(source: string) {
  const result = assemble(source);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  return result;
}

describe("KUE-CHIP2 emulator conformance", () => {
  it("resets deterministically", () => {
    const cpu = new KueChip2();
    cpu.state.acc = 1;
    cpu.state.cf = 1;
    cpu.reset();
    expect(cpu.state.acc).toBe(0);
    expect(cpu.state.ix).toBe(0);
    expect(cpu.state.pc).toBe(0);
    expect(cpu.state.ir).toBe(0);
    expect(cpu.state.mar).toBe(0);
    expect(cpu.state.cf).toBe(0);
    expect(cpu.state.vf).toBe(0);
    expect(cpu.state.nf).toBe(0);
    expect(cpu.state.zf).toBe(0);
    expect(cpu.state.halt).toBe(false);
  });

  it("fetches through P0/P1 and halts on P2", () => {
    const cpu = new KueChip2([0x0f]);
    let phase = cpu.stepPhase();
    expect(phase.after.mar).toBe(0x00);
    expect(phase.after.pc).toBe(0x01);
    phase = cpu.stepPhase();
    expect(phase.after.ir).toBe(0x0f);
    phase = cpu.stepPhase();
    expect(phase.after.halt).toBe(true);
  });

  it("implements LD register direction as destination <- source", () => {
    const assembled = mustAssemble(`
      LD ACC, 01H
      LD IX,  02H
      LD ACC, IX
      ST ACC, (00H)
      ST IX,  (01H)
      HLT
    `);
    const cpu = new KueChip2(assembled.program);
    cpu.run();
    expect(cpu.state.data[0x00]).toBe(0x02);
    expect(cpu.state.data[0x01]).toBe(0x02);
  });

  it("allows program memory writes", () => {
    const assembled = mustAssemble(`
      EOR ACC, ACC
      ST  ACC, [80H]
      LD  ACC, 55H
      ST  ACC, [80H]
      LD  ACC, [80H]
      ST  ACC, (00H)
      HLT
    `);
    const cpu = new KueChip2(assembled.program);
    cpu.run();
    expect(cpu.state.program[0x80]).toBe(0x55);
    expect(cpu.state.data[0x00]).toBe(0x55);
  });

  it("accepts immediate alias opcode but assembler emits canonical encodings", () => {
    const assembled = mustAssemble("LD ACC, 12H\nHLT");
    expect(Array.from(assembled.program.slice(0, 3))).toEqual([0x62, 0x12, 0x0f]);

    const cpu = new KueChip2([0x63, 0x12, 0x0f]);
    cpu.run();
    expect(cpu.state.acc).toBe(0x12);
  });

  it("branches to absolute targets", () => {
    const assembled = mustAssemble(`
      BA target
      LD ACC, 01H
    target:
      LD ACC, 02H
      HLT
    `);
    const cpu = new KueChip2(assembled.program);
    cpu.run();
    expect(cpu.state.acc).toBe(0x02);
  });

  it("implements SBC borrow flag", () => {
    const assembled = mustAssemble("SBC ACC, 05H\nHLT");
    const cpu = new KueChip2(assembled.program);
    cpu.state.acc = 0x03;
    cpu.state.cf = 0;
    cpu.run();
    expect(cpu.state.acc).toBe(0xfe);
    expect(cpu.state.cf).toBe(1);
    expect(cpu.state.nf).toBe(1);
    expect(cpu.state.zf).toBe(0);
  });

  it("implements RLA through carry", () => {
    const assembled = mustAssemble("RLA ACC\nHLT");
    const cpu = new KueChip2(assembled.program);
    cpu.state.acc = 0x80;
    cpu.state.cf = 1;
    cpu.run();
    expect(cpu.state.acc).toBe(0x01);
    expect(cpu.state.cf).toBe(1);
    expect(cpu.state.zf).toBe(0);
    expect(cpu.state.nf).toBe(0);
    expect(cpu.state.vf).toBe(1);
  });

  it("does not modify CF for ADD", () => {
    const assembled = mustAssemble("ADD ACC, 01H\nHLT");
    const cpu = new KueChip2(assembled.program);
    cpu.state.acc = 0xff;
    cpu.state.cf = 0;
    cpu.run();
    expect(cpu.state.acc).toBe(0x00);
    expect(cpu.state.cf).toBe(0);
    expect(cpu.state.zf).toBe(1);
  });

  it("does not modify A or CF for CMP", () => {
    const assembled = mustAssemble("CMP ACC, 02H\nHLT");
    const cpu = new KueChip2(assembled.program);
    cpu.state.acc = 0x01;
    cpu.state.cf = 1;
    cpu.run();
    expect(cpu.state.acc).toBe(0x01);
    expect(cpu.state.cf).toBe(1);
    expect(cpu.state.nf).toBe(1);
    expect(cpu.state.zf).toBe(0);
  });

  it("updates shift register on P2 and flags on P3", () => {
    const assembled = mustAssemble("RLA ACC\nHLT");
    const cpu = new KueChip2(assembled.program);
    cpu.state.acc = 0x80;
    cpu.state.cf = 1;
    cpu.stepPhase();
    cpu.stepPhase();
    const p2 = cpu.stepPhase();
    expect(p2.after.acc).toBe(0x01);
    expect(p2.after.cf).toBe(1);
    const p3 = cpu.stepPhase();
    expect(p3.after.vf).toBe(1);
  });
});

describe("assembler", () => {
  it("supports labels, .data, .equ, and character literals", () => {
    const result = mustAssemble(`
      .equ answer, 2AH
      LD ACC, (x)
      ADD ACC, answer
      HLT
      .data 80H
    x:
      .byte 'A'
    `);
    expect(result.program[0]).toBe(0x65);
    expect(result.program[1]).toBe(0x80);
    expect(result.program[2]).toBe(0xb2);
    expect(result.program[3]).toBe(0x2a);
    expect(result.data[0x80]).toBe(65);
    expect(result.symbols.get("x")).toBe(0x80);
  });

  it("rejects invalid ST operands", () => {
    const result = assemble("ST ACC, 1");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("ST"))).toBe(true);
  });

  it("rejects out-of-range byte values", () => {
    const result = assemble(".byte 256");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("outside 8-bit"))).toBe(true);
  });
});

describe("ISA and disassembler", () => {
  it("classifies all opcodes", () => {
    for (let opcode = 0; opcode <= 0xff; opcode += 1) {
      expect(decodeOpcode(opcode).kind.length).toBeGreaterThan(0);
    }
  });

  it("disassembles immediate aliases canonically", () => {
    expect(disassemble([0x63, 0x12]).lines[0]).toBe("00H: LD ACC, 12H");
  });

  it("disassembles HLT aliases", () => {
    expect(disassemble([0x50]).lines[0]).toBe("00H: HLT");
  });

  it("disassembles invalid ST opcodes as data bytes", () => {
    expect(disassemble([0x70]).lines[0]).toBe("00H: .db 70H");
  });
});
