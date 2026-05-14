import { bit7, toBit, toU8, zflag } from "../isa/index.js";
import type { AluInstructionKind, Bit, U8 } from "../types.js";

export type AluResult = {
  result: U8;
  cf?: Bit;
  vf: Bit;
  nf: Bit;
  zf: Bit;
};

export function executeAlu(kind: AluInstructionKind, lhs: U8, rhs: U8, cf: Bit): AluResult {
  switch (kind) {
    case "ADC": {
      const wide = lhs + rhs + cf;
      const result = toU8(wide);
      return {
        result,
        cf: toBit(wide > 0xff),
        vf: toBit(((lhs ^ result) & (rhs ^ result) & 0x80) !== 0),
        nf: bit7(result),
        zf: zflag(result),
      };
    }
    case "ADD": {
      const result = toU8(lhs + rhs);
      return {
        result,
        vf: toBit(((lhs ^ result) & (rhs ^ result) & 0x80) !== 0),
        nf: bit7(result),
        zf: zflag(result),
      };
    }
    case "SBC": {
      const wide = lhs - rhs - cf;
      const result = toU8(wide);
      const subtrahend = toU8(rhs + cf);
      return {
        result,
        cf: toBit(wide < 0),
        vf: toBit(((lhs ^ subtrahend) & (lhs ^ result) & 0x80) !== 0),
        nf: bit7(result),
        zf: zflag(result),
      };
    }
    case "SUB":
    case "CMP": {
      const result = toU8(lhs - rhs);
      return {
        result,
        vf: toBit(((lhs ^ rhs) & (lhs ^ result) & 0x80) !== 0),
        nf: bit7(result),
        zf: zflag(result),
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
