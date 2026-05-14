# KUE-CHIP2 エミュレータ・アセンブラ実装仕様書

Version: 0.1  
Target: KUE-CHIP2 教育用ボード互換 ISA / フェーズ実行エミュレータ / アセンブラ  
Primary reference: `KUE-CHIP2 教育用ボード リファレンスマニュアル`, especially pp.67–74.

---

## 0. 本仕様書の目的

本仕様書は、KUE-CHIP2 の

- アセンブラ
- 逆アセンブラ
- 命令単位エミュレータ
- フェーズ単位エミュレータ
- C サブセット向けコンパイラバックエンド

を実装するための実行仕様である。

特に、次を明確化する。

1. CPU 状態
2. メモリモデル
3. opcode デコード
4. アドレスモード
5. 命令意味
6. フラグ更新規則
7. `P0`〜`P4` のフェーズ動作
8. I/O バッファ動作
9. illegal / undefined opcode の扱い
10. アセンブラ構文と出力規則

本仕様書では、マニュアル上に矛盾・曖昧さがある箇所について、エミュレータ実装上の決定を明示する。

---

## 1. 用語

| 用語 | 意味 |
|---|---|
| `u8` | 8bit unsigned integer, `0x00..0xFF` |
| `bit` | `0` or `1` |
| `program` | プログラム領域。256 byte |
| `data` | データ領域。256 byte |
| `A` | opcode 中の destination register selector |
| `B` | opcode 中の source / addressing mode selector |
| `d` | 2語目の即値・アドレス・変位 |
| `ea` | effective address |
| `P0..P4` | 命令実行フェーズ |
| `DBi` | 入力側データバス |
| `DBo` | 出力側データバス |
| `AB` | アドレスバス |

---

## 2. 基本型

```ts
type u8 = number;  // always 0..255
type bit = 0 | 1;
```

すべての 8bit 値は次で正規化する。

```ts
function toU8(x: number): number {
  return x & 0xff;
}
```

8bit 加算・減算・アドレス計算はすべて wraparound する。

```text
0xFF + 1 = 0x00
0x00 - 1 = 0xFF
```

---

## 3. CPU 状態

```ts
type CpuState = {
  // registers
  acc: u8;       // accumulator
  ix: u8;        // index register
  pc: u8;        // program counter
  ir: u8;        // instruction register
  mar: u8;       // memory address register

  // flags
  cf: bit;       // carry / borrow
  vf: bit;       // overflow
  nf: bit;       // negative
  zf: bit;       // zero

  // memory
  program: Uint8Array; // 256 bytes
  data: Uint8Array;    // 256 bytes

  // I/O buffers
  ibuf: u8;
  obuf: u8;
  ibufFlag: bit;
  obufFlag: bit;

  // execution state
  halt: boolean;
  phase: 0 | 1 | 2 | 3 | 4;

  // optional internal state for phase-accurate execution
  tcf?: bit;           // temporary carry flag used by shift/rotate
  decoded?: DecodedInstruction;
};
```

---

## 4. Reset

エミュレータの deterministic reset は次とする。

```text
ACC = 0
IX  = 0
PC  = 0
IR  = 0
MAR = 0

CF = 0
VF = 0
NF = 0
ZF = 0

IBUF = 0
OBUF = 0
IBUF_FLAG = 0
OBUF_FLAG = 0

halt = false
phase = P0
```

実機の全レジスタ初期値が未定義である可能性はあるが、アセンブラ・コンパイラ検証環境では deterministic reset を採用する。

---

## 5. メモリモデル

KUE-CHIP2 は、命令表上、プログラム領域とデータ領域を区別する。

```text
program[0x00..0xFF]
data[0x00..0xFF]
```

表示・説明上は、データ領域を論理的に `0x100..0x1FF` と見なしてもよい。ただし、エミュレータ内部では 8bit index の `data[0x00..0xFF]` として持つ。

### 5.1 命令フェッチ

命令フェッチは常に `program` から行う。

```text
P0: MAR <- PC, PC++
P1: IR <- program[MAR]
```

### 5.2 2語目 operand の読み出し

2語命令の 2語目 `d` は常に `program` から読む。

```text
d = program[MAR]
```

### 5.3 アドレスモードごとの参照領域

| 表記 | 意味 | 実アクセス |
|---|---|---|
| `d` | 即値 | `program[PC_old]` の値そのもの |
| `[d]` | プログラム領域絶対参照 | `program[d]` |
| `(d)` | データ領域絶対参照 | `data[d]` |
| `[IX+d]` | プログラム領域 index 参照 | `program[(IX + d) & 0xff]` |
| `(IX+d)` | データ領域 index 参照 | `data[(IX + d) & 0xff]` |

### 5.4 プログラム領域への書き込み

`ST A,[d]` および `ST A,[IX+d]` により、プログラム領域へ書き込める。

したがって、エミュレータで `program` を read-only にしてはならない。

教材サンプルでは、プログラム領域の未使用アドレス、例えば `0x80`, `0x81`, `0x82`, `0x83`, `0xF0` などを変数領域として使う例がある。

---

## 6. レジスタ指定

opcode 中の `A` field は destination register を選ぶ。

| `A` | register |
|---:|---|
| `0` | `ACC` |
| `1` | `IX` |

opcode 中の `B` field は source または addressing mode を選ぶ。

| `B` | 表記 | 意味 |
|---:|---|---|
| `000` | `ACC` | accumulator |
| `001` | `IX` | index register |
| `010` | `d` | immediate |
| `011` | `d` | immediate alias |
| `100` | `[d]` | program absolute |
| `101` | `(d)` | data absolute |
| `110` | `[IX+d]` | program indexed |
| `111` | `(IX+d)` | data indexed |

`B=010` と `B=011` はどちらも即値 `d` として扱う。

アセンブラは canonical encoding として `B=010` を出力する。逆アセンブラは `B=011` も `d` として表示する。

---

## 7. 命令長

| 命令形式 | byte数 |
|---|---:|
| `NOP`, `HLT`, `OUT`, `IN`, `RCF`, `SCF`, `Shift/Rotate` | 1 |
| `Bcc` | 2 |
| `LD/ST/ALU` with register operand | 1 |
| `LD/ST/ALU` with `d`, `[d]`, `(d)`, `[IX+d]`, `(IX+d)` | 2 |

---

## 8. opcode 分類

### 8.1 Fixed / control / I/O

| opcode pattern | opcode range | mnemonic | length | 動作 |
|---|---:|---|---:|---|
| `00000---` | `00..07` | `NOP` | 1 | no operation |
| `00001---` | `08..0F` | `HLT` | 1 | halt |
| `00010---` | `10..17` | `OUT` | 1 | output |
| `00011---` | `18..1F` | `IN` | 1 | input |
| `00100---` | `20..27` | `RCF` | 1 | clear CF |
| `00101---` | `28..2F` | `SCF` | 1 | set CF |
| `0101----` | `50..5F` | `HLT` | 1 | halt |

`00001---` はすべて HLT とする。  
`0101----` もすべて HLT とする。

### 8.2 Branch

```text
0011 cccc
```

| opcode | mnemonic |
|---:|---|
| `30` | `BA` |
| `31` | `BNZ` |
| `32` | `BZP` |
| `33` | `BP` |
| `34` | `BNI` |
| `35` | `BNC` |
| `36` | `BGE` |
| `37` | `BGT` |
| `38` | `BVF` |
| `39` | `BZ` |
| `3A` | `BN` |
| `3B` | `BZN` |
| `3C` | `BNO` |
| `3D` | `BC` |
| `3E` | `BLT` |
| `3F` | `BLE` |

### 8.3 Shift / Rotate

```text
0100 A q sm
```

| field | 意味 |
|---|---|
| `A` | target register: `0=ACC`, `1=IX` |
| `q=0` | shift |
| `q=1` | rotate |
| `sm=00` | right arithmetic |
| `sm=01` | left arithmetic |
| `sm=10` | right logical |
| `sm=11` | left logical |

| mnemonic | ACC opcode | IX opcode |
|---|---:|---:|
| `SRA` | `40` | `48` |
| `SLA` | `41` | `49` |
| `SRL` | `42` | `4A` |
| `SLL` | `43` | `4B` |
| `RRA` | `44` | `4C` |
| `RLA` | `45` | `4D` |
| `RRL` | `46` | `4E` |
| `RLL` | `47` | `4F` |

### 8.4 LD / ST / ALU

```text
LD   0110 A B
ST   0111 A B
SBC  1000 A B
ADC  1001 A B
SUB  1010 A B
ADD  1011 A B
EOR  1100 A B
OR   1101 A B
AND  1110 A B
CMP  1111 A B
```

---

## 9. 命令コード早見表

### 9.1 ACC destination

| 命令 | `ACC` | `IX` | `d` | `[d]` | `(d)` | `[IX+d]` | `(IX+d)` |
|---|---:|---:|---:|---:|---:|---:|---:|
| `LD ACC,` | `60` | `61` | `62` | `64` | `65` | `66` | `67` |
| `ST ACC,` | — | — | — | `74` | `75` | `76` | `77` |
| `SBC ACC,` | `80` | `81` | `82` | `84` | `85` | `86` | `87` |
| `ADC ACC,` | `90` | `91` | `92` | `94` | `95` | `96` | `97` |
| `SUB ACC,` | `A0` | `A1` | `A2` | `A4` | `A5` | `A6` | `A7` |
| `ADD ACC,` | `B0` | `B1` | `B2` | `B4` | `B5` | `B6` | `B7` |
| `EOR ACC,` | `C0` | `C1` | `C2` | `C4` | `C5` | `C6` | `C7` |
| `OR ACC,` | `D0` | `D1` | `D2` | `D4` | `D5` | `D6` | `D7` |
| `AND ACC,` | `E0` | `E1` | `E2` | `E4` | `E5` | `E6` | `E7` |
| `CMP ACC,` | `F0` | `F1` | `F2` | `F4` | `F5` | `F6` | `F7` |

### 9.2 IX destination

| 命令 | `ACC` | `IX` | `d` | `[d]` | `(d)` | `[IX+d]` | `(IX+d)` |
|---|---:|---:|---:|---:|---:|---:|---:|
| `LD IX,` | `68` | `69` | `6A` | `6C` | `6D` | `6E` | `6F` |
| `ST IX,` | — | — | — | `7C` | `7D` | `7E` | `7F` |
| `SBC IX,` | `88` | `89` | `8A` | `8C` | `8D` | `8E` | `8F` |
| `ADC IX,` | `98` | `99` | `9A` | `9C` | `9D` | `9E` | `9F` |
| `SUB IX,` | `A8` | `A9` | `AA` | `AC` | `AD` | `AE` | `AF` |
| `ADD IX,` | `B8` | `B9` | `BA` | `BC` | `BD` | `BE` | `BF` |
| `EOR IX,` | `C8` | `C9` | `CA` | `CC` | `CD` | `CE` | `CF` |
| `OR IX,` | `D8` | `D9` | `DA` | `DC` | `DD` | `DE` | `DF` |
| `AND IX,` | `E8` | `E9` | `EA` | `EC` | `ED` | `EE` | `EF` |
| `CMP IX,` | `F8` | `F9` | `FA` | `FC` | `FD` | `FE` | `FF` |

---

## 10. フラグ

### 10.1 フラグ一覧

| flag | 意味 |
|---|---|
| `CF` | Carry / Borrow |
| `VF` | Overflow |
| `NF` | Negative |
| `ZF` | Zero |

表示用に 8bit `FLAG` 値を作る場合は次とする。

```text
FLAG bit0 = ZF
FLAG bit1 = NF
FLAG bit2 = VF
FLAG bit3 = CF
FLAG bit7..4 = 0
```

### 10.2 フラグを変更しない命令

次の命令は `CF/VF/NF/ZF` を変更しない。

```text
NOP
HLT
OUT
IN
LD
ST
Bcc
```

### 10.3 RCF / SCF

```text
RCF: CF <- 0
SCF: CF <- 1
```

`VF/NF/ZF` は変更しない。

### 10.4 ALU 命令のフラグ更新

| 命令 | CF入力 | CF更新 | VF | NF | ZF |
|---|---:|---:|---:|---:|---:|
| `SBC` | あり | あり | 更新 | 更新 | 更新 |
| `ADC` | あり | あり | 更新 | 更新 | 更新 |
| `SUB` | なし | なし | 更新 | 更新 | 更新 |
| `ADD` | なし | なし | 更新 | 更新 | 更新 |
| `EOR` | なし | なし | `0` | 更新 | 更新 |
| `OR` | なし | なし | `0` | 更新 | 更新 |
| `AND` | なし | なし | `0` | 更新 | 更新 |
| `CMP` | なし | なし | 更新 | 更新 | 更新 |

重要: `ADD`, `SUB`, `CMP` は `CF` を更新しない。

### 10.5 Shift / Rotate のフラグ更新

すべての shift / rotate で、命令完了時に次を更新する。

```text
NF = result bit7
ZF = result == 0
CF = shifted-out / rotated-out bit
```

`VF` は命令ごとに異なる。

| 命令 | VF |
|---|---|
| `SRA` | `0` |
| `SLA` | `old bit7 xor result bit7` |
| `SRL` | `0` |
| `SLL` | `0` |
| `RRA` | `0` |
| `RLA` | `old bit7 xor result bit7` |
| `RRL` | `0` |
| `RLL` | `0` |

---

## 11. ALU 演算仕様

対象レジスタを `A`、source operand を `B` と表記する。

### 11.1 共通ヘルパ

```ts
function bit7(x: number): bit {
  return ((x & 0x80) !== 0 ? 1 : 0);
}

function zflag(x: number): bit {
  return ((x & 0xff) === 0 ? 1 : 0);
}
```

### 11.2 ADC

```text
tmp = A + B + CF
result = tmp & 0xff
CF = tmp > 0xff
VF = signed overflow of A + B + CF
NF = result bit7
ZF = result == 0
A <- result
```

実装:

```ts
function adc(a: u8, b: u8, cf: bit) {
  const wide = a + b + cf;
  const result = wide & 0xff;
  const newCF = wide > 0xff ? 1 : 0;
  const newVF = (((a ^ result) & (b ^ result) & 0x80) !== 0) ? 1 : 0;
  return { result, cf: newCF, vf: newVF, nf: bit7(result), zf: zflag(result) };
}
```

### 11.3 ADD

```text
tmp = A + B
result = tmp & 0xff
CF unchanged
VF = signed overflow of A + B
NF = result bit7
ZF = result == 0
A <- result
```

```ts
function add(a: u8, b: u8) {
  const wide = a + b;
  const result = wide & 0xff;
  const newVF = (((a ^ result) & (b ^ result) & 0x80) !== 0) ? 1 : 0;
  return { result, vf: newVF, nf: bit7(result), zf: zflag(result) };
}
```

### 11.4 SBC

`SBC` は borrow flag 入力付き減算である。

```text
tmp = A - B - CF
result = tmp & 0xff
CF = borrow occurred
VF = signed overflow of A - B - CF
NF = result bit7
ZF = result == 0
A <- result
```

```ts
function sbc(a: u8, b: u8, cf: bit) {
  const wide = a - b - cf;
  const result = wide & 0xff;
  const newCF = wide < 0 ? 1 : 0;
  const subtrahend = (b + cf) & 0xff;
  const newVF = (((a ^ subtrahend) & (a ^ result) & 0x80) !== 0) ? 1 : 0;
  return { result, cf: newCF, vf: newVF, nf: bit7(result), zf: zflag(result) };
}
```

### 11.5 SUB

```text
tmp = A - B
result = tmp & 0xff
CF unchanged
VF = signed overflow of A - B
NF = result bit7
ZF = result == 0
A <- result
```

```ts
function sub(a: u8, b: u8) {
  const wide = a - b;
  const result = wide & 0xff;
  const newVF = (((a ^ b) & (a ^ result) & 0x80) !== 0) ? 1 : 0;
  return { result, vf: newVF, nf: bit7(result), zf: zflag(result) };
}
```

### 11.6 CMP

```text
tmp = A - B
result = tmp & 0xff
CF unchanged
VF = signed overflow of A - B
NF = result bit7
ZF = result == 0
A unchanged
```

`CMP` は destination register を書き換えない。

### 11.7 EOR

```text
result = A xor B
VF = 0
NF = result bit7
ZF = result == 0
CF unchanged
A <- result
```

### 11.8 OR

```text
result = A or B
VF = 0
NF = result bit7
ZF = result == 0
CF unchanged
A <- result
```

### 11.9 AND

```text
result = A and B
VF = 0
NF = result bit7
ZF = result == 0
CF unchanged
A <- result
```

---

## 12. Shift / Rotate 演算仕様

対象レジスタを `X` とする。`X` は `ACC` または `IX`。

### 12.1 SRA

Arithmetic right shift.

```text
old = X
result = (old & 0x80) | (old >> 1)
CF = old bit0
VF = 0
NF = result bit7
ZF = result == 0
X <- result
```

### 12.2 SLA

Arithmetic left shift.

```text
old = X
result = (old << 1) & 0xff
CF = old bit7
VF = old bit7 xor result bit7
NF = result bit7
ZF = result == 0
X <- result
```

### 12.3 SRL

Logical right shift.

```text
old = X
result = old >> 1
CF = old bit0
VF = 0
NF = result bit7
ZF = result == 0
X <- result
```

### 12.4 SLL

Logical left shift.

```text
old = X
result = (old << 1) & 0xff
CF = old bit7
VF = 0
NF = result bit7
ZF = result == 0
X <- result
```

### 12.5 RRA

Rotate right through carry.

```text
old = X
oldCF = CF
result = (oldCF << 7) | (old >> 1)
CF = old bit0
VF = 0
NF = result bit7
ZF = result == 0
X <- result
```

### 12.6 RLA

Rotate left through carry.

```text
old = X
oldCF = CF
result = ((old << 1) & 0xff) | oldCF
CF = old bit7
VF = old bit7 xor result bit7
NF = result bit7
ZF = result == 0
X <- result
```

### 12.7 RRL

Rotate right logically, not through carry.

```text
old = X
result = (old >> 1) | ((old & 0x01) << 7)
CF = old bit0
VF = 0
NF = result bit7
ZF = result == 0
X <- result
```

### 12.8 RLL

Rotate left logically, not through carry.

```text
old = X
result = ((old << 1) & 0xff) | ((old >> 7) & 1)
CF = old bit7
VF = 0
NF = result bit7
ZF = result == 0
X <- result
```

---

## 13. 分岐条件

`Bcc` は 2byte 命令である。

```text
byte0 = 0011 cccc
byte1 = branch target absolute address
```

分岐先は相対アドレスではなく、8bit 絶対アドレスである。

| mnemonic | cc | 条件 |
|---|---:|---|
| `BA` | `0` | true |
| `BNZ` | `1` | `ZF == 0` |
| `BZP` | `2` | `NF == 0` |
| `BP` | `3` | `(NF | ZF) == 0` |
| `BNI` | `4` | `IBUF_FLAG == 0` |
| `BNC` | `5` | `CF == 0` |
| `BGE` | `6` | `(VF xor NF) == 0` |
| `BGT` | `7` | `((VF xor NF) | ZF) == 0` |
| `BVF` | `8` | `VF == 1` |
| `BZ` | `9` | `ZF == 1` |
| `BN` | `A` | `NF == 1` |
| `BZN` | `B` | `(NF | ZF) == 1` |
| `BNO` | `C` | `OBUF_FLAG == 1` |
| `BC` | `D` | `CF == 1` |
| `BLT` | `E` | `(VF xor NF) == 1` |
| `BLE` | `F` | `((VF xor NF) | ZF) == 1` |

実装:

```ts
function branchCond(cc: number, s: CpuState): boolean {
  switch (cc & 0xf) {
    case 0x0: return true;
    case 0x1: return s.zf === 0;
    case 0x2: return s.nf === 0;
    case 0x3: return (s.nf | s.zf) === 0;
    case 0x4: return s.ibufFlag === 0;
    case 0x5: return s.cf === 0;
    case 0x6: return (s.vf ^ s.nf) === 0;
    case 0x7: return ((s.vf ^ s.nf) | s.zf) === 0;
    case 0x8: return s.vf === 1;
    case 0x9: return s.zf === 1;
    case 0xa: return s.nf === 1;
    case 0xb: return (s.nf | s.zf) === 1;
    case 0xc: return s.obufFlag === 1;
    case 0xd: return s.cf === 1;
    case 0xe: return (s.vf ^ s.nf) === 1;
    case 0xf: return ((s.vf ^ s.nf) | s.zf) === 1;
  }
  throw new Error("unreachable");
}
```

---

## 14. I/O 仕様

### 14.1 IBUF

```text
IBUF      : 8bit input buffer
IBUF_FLAG : input availability flag
```

外部から入力を与える API:

```ts
function setInput(value: u8): void {
  ibuf = value & 0xff;
  ibufFlag = 1;
}
```

### 14.2 OBUF

```text
OBUF      : 8bit output buffer
OBUF_FLAG : output availability flag
```

外部が出力を読む API:

```ts
function readOutput(): u8 {
  return obuf;
}

function clearOutputFlag(): void {
  obufFlag = 0;
}
```

### 14.3 IN

命令単位の最終効果:

```text
ACC <- IBUF
IBUF_FLAG <- 0
```

フェーズ単位:

```text
P2 end:
  ACC <- IBUF

P3 end:
  IBUF_FLAG <- 0
```

### 14.4 OUT

命令単位の最終効果:

```text
OBUF <- ACC
OBUF_FLAG <- 1
```

フェーズ単位:

```text
P2 end:
  OBUF <- ACC

P3 end:
  OBUF_FLAG <- 1
```

`OBUF_WE`, `IBUF_RE`, `IBUF_FLG_CLR` は active-low 制御信号として扱うが、ISA エミュレータでは信号線レベルの再現は不要である。

---

## 15. フェーズ実行モデル

### 15.1 基本原則

各フェーズでは、フェーズ開始時の状態を読み、フェーズ終了時にレジスタ・メモリ・フラグを一括更新する。

例:

```text
P0:
  MAR <- old PC
  PC  <- old PC + 1
```

`MAR <- PC` と `PC++` は同じフェーズに存在するため、`MAR` には increment 前の `PC` が入る。

### 15.2 共通フェッチ

全命令共通。

```text
P0:
  MAR <- PC
  PC  <- PC + 1

P1:
  IR <- program[MAR]
```

`IR` は `P1` で命令語を保持し、`P2` 以降のデコードに使われる。  
命令完了後も `IR` の値は次命令の `P1` まで残るが、命令履歴として保証されるものではない。

### 15.3 HLT

```text
P2:
  halt <- true
```

### 15.4 NOP

```text
P2:
  no operation
```

### 15.5 OUT

```text
P2:
  OBUF <- ACC

P3:
  OBUF_FLAG <- 1
```

### 15.6 IN

```text
P2:
  ACC <- IBUF

P3:
  IBUF_FLAG <- 0
```

### 15.7 RCF

```text
P2:
  CF <- 0
```

### 15.8 SCF

```text
P2:
  CF <- 1
```

### 15.9 Bcc

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  if condition(cc):
    PC <- program[MAR]
```

条件不成立でも 2語目は消費される。

### 15.10 Shift / Rotate

```text
P2:
  target register <- shifted/rotated result
  TCF <- shifted-out / rotated-out bit
  TVF <- computed overflow value if needed

P3:
  CF <- TCF
  VF <- TVF or 0
  NF <- result bit7
  ZF <- result == 0
```

フェーズ正確エミュレータでは、`P2` 後に対象レジスタのみ更新され、`CF/VF/NF/ZF` はまだ旧値である。  
`P3` 後にフラグが更新される。

### 15.11 LD A,reg

```text
P2:
  A <- B
```

ここで `A` は destination register、`B` は source register である。

注意: マニュアル p.73 のフェーズ表では `LD` の `ACC/IX` 行が `(A) -> B` と読めるが、p.69 の命令機能 `(B) -> A`、opcode 表、サンプルコードと矛盾するため、誤植とみなす。

### 15.12 LD A,d

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  A <- program[MAR]
```

### 15.13 LD A,[d]

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- program[MAR]

P4:
  A <- program[MAR]
```

### 15.14 LD A,(d)

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- program[MAR]

P4:
  A <- data[MAR]
```

### 15.15 LD A,[IX+d]

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- (IX + program[MAR]) & 0xff

P4:
  A <- program[MAR]
```

### 15.16 LD A,(IX+d)

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- (IX + program[MAR]) & 0xff

P4:
  A <- data[MAR]
```

### 15.17 ST A,[d]

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- program[MAR]

P4:
  program[MAR] <- A
```

### 15.18 ST A,(d)

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- program[MAR]

P4:
  data[MAR] <- A
```

### 15.19 ST A,[IX+d]

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- (IX + program[MAR]) & 0xff

P4:
  program[MAR] <- A
```

### 15.20 ST A,(IX+d)

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- (IX + program[MAR]) & 0xff

P4:
  data[MAR] <- A
```

### 15.21 ALU A,reg

```text
P2:
  tmp <- ALU(A, B)
  flags <- result flags
  if instruction != CMP:
    A <- tmp
```

`SBC` / `ADC` では `CF` を入力として使う。  
`SBC` / `ADC` だけ `CF` を更新する。

### 15.22 ALU A,d

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  tmp <- ALU(A, program[MAR])
  flags <- result flags
  if instruction != CMP:
    A <- tmp
```

### 15.23 ALU A,[d]

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- program[MAR]

P4:
  tmp <- ALU(A, program[MAR])
  flags <- result flags
  if instruction != CMP:
    A <- tmp
```

### 15.24 ALU A,(d)

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- program[MAR]

P4:
  tmp <- ALU(A, data[MAR])
  flags <- result flags
  if instruction != CMP:
    A <- tmp
```

### 15.25 ALU A,[IX+d]

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- (IX + program[MAR]) & 0xff

P4:
  tmp <- ALU(A, program[MAR])
  flags <- result flags
  if instruction != CMP:
    A <- tmp
```

### 15.26 ALU A,(IX+d)

```text
P2:
  MAR <- PC
  PC  <- PC + 1

P3:
  MAR <- (IX + program[MAR]) & 0xff

P4:
  tmp <- ALU(A, data[MAR])
  flags <- result flags
  if instruction != CMP:
    A <- tmp
```

---

## 16. 命令単位実行モデル

命令単位エミュレータでは、`P0..P4` を内部でまとめて実行してよい。  
ただし、最終状態はフェーズ実行を最後まで行った場合と一致しなければならない。

推奨 API:

```ts
class KueChip2 {
  state: CpuState;

  reset(): void;
  loadProgram(bytes: Uint8Array, offset?: number): void;
  loadData(bytes: Uint8Array, offset?: number): void;

  stepPhase(): PhaseTrace;
  stepInstruction(): InstructionTrace;
  run(maxInstructions?: number): RunTrace;

  setInput(value: u8): void;
  readOutput(): u8;
  clearOutputFlag(): void;
}
```

### 16.1 InstructionTrace

```ts
type CpuSnapshot = Readonly<CpuState>;

type PhaseTrace = {
  phase: 0 | 1 | 2 | 3 | 4;
  before: CpuSnapshot;
  after: CpuSnapshot;
};

type InstructionTrace = {
  pcBefore: u8;
  irAfterFetch: u8;
  pcAfter: u8;
  phases: PhaseTrace[];
  after: CpuSnapshot;
};
```

表示上は次を採用する。

```text
実行前 PC = P0 前の PC
実行後 PC = 最終フェーズ後の PC
ACC/IX/FLAG = 最終フェーズ後の値
IR = P1 で読み込まれ、次命令 P1 まで残っている値
MAR = 最後にその命令で書き込まれた値
```

---

## 17. illegal / undefined opcode

### 17.1 HLT として扱う opcode

次は HLT とする。

```text
08..0F
50..5F
```

### 17.2 NOP として扱う opcode

次は NOP とする。

```text
00..07
```

### 17.3 OUT / IN / RCF / SCF の alias

次は各命令として扱う。

```text
10..17 = OUT
18..1F = IN
20..27 = RCF
28..2F = SCF
```

### 17.4 ST の無効 operand

`ST` は `ST A,{ma}` のみ正規命令である。

無効:

```text
ST A,ACC
ST A,IX
ST A,d
```

該当 opcode:

```text
70, 71, 72, 73
78, 79, 7A, 7B
```

推奨動作:

| 実装 | 動作 |
|---|---|
| assembler | エラー |
| emulator strict mode | illegal instruction trap |
| emulator permissive mode | illegal instruction trap または停止 |
| disassembler | `.db 70H` のように表示、または `ILLEGAL` |

これらは HLT として扱わない。  
`HLT 00001---` や `0101----` のように明示された don't care ではないためである。

---

## 18. アセンブラ仕様

### 18.1 基本構文

```asm
LABEL:
  MNEMONIC operand1, operand2
  ; comment
```

例:

```asm
LD  ACC, 10H
LD  IX,  0
LD  ACC, [80H]
LD  ACC, (20H)
LD  ACC, [IX+04H]
LD  ACC, (IX+04H)
ST  ACC, [F0H]
ADD ACC, IX
CMP ACC, 0
BZ  LABEL
HLT
```

### 18.2 コメント

`;` 以降をコメントとする。

```asm
LD ACC, 1  ; comment
```

互換性を持たせるなら、行頭 `*` もコメントとして許可してよい。

```asm
* comment
```

### 18.3 数値リテラル

最低限、次をサポートする。

| 表記 | 例 | 値 |
|---|---|---:|
| decimal | `10` | 10 |
| hex prefix | `0x10` | 16 |
| hex suffix | `10H` | 16 |
| binary prefix | `0b1010` | 10 |
| binary suffix | `1010B` | 10 |
| char | `'A'` | 65 |

すべての出力値は 8bit に収まる必要がある。  
範囲外はエラーとする。

### 18.4 ラベル

ラベルは現在の program address または data address に束縛される。

```asm
main:
  LD ACC, (x)
  HLT

.data 80H
x:
  .byte 42
```

### 18.5 疑似命令

推奨疑似命令:

| directive | 意味 |
|---|---|
| `.org addr` | program location counter 設定 |
| `.program addr` | program 領域へ切替 |
| `.data addr` | data 領域へ切替 |
| `.byte values...` | byte 列配置 |
| `.db values...` | `.byte` alias |
| `.equ name, value` | 定数定義 |
| `END` | 入力終了、互換用 |

教材互換のため、次の EQU 形式も許可するとよい。

```asm
DVD: EQU 80H
```

### 18.6 program / data 領域

アセンブラは少なくとも2つの出力領域を持つ。

```text
program image: 256 bytes
data image   : 256 bytes
```

未指定領域の初期値は `0x00` とするのが扱いやすい。  
ただし、明示的に未初期化を区別したい場合は assemble result に initialized bitmap を持ってもよい。

### 18.7 operand parsing

| assembly | mode |
|---|---|
| `ACC` | register |
| `IX` | register |
| `10H` | immediate |
| `[10H]` | program absolute |
| `(10H)` | data absolute |
| `[IX+10H]` | program indexed |
| `(IX+10H)` | data indexed |
| `[IX]` | `[IX+0]` として許可してよい |
| `(IX)` | `(IX+0)` として許可してよい |

### 18.8 canonical encoding

HLT は既定の出力として `0F` を使う。

即値 `d` は `B=010` で出力する。

```text
LD ACC,d  = 62 dd
LD IX,d   = 6A dd
ADD ACC,d = B2 dd
SUB IX,d  = AA dd
```

`B=011` の alias はアセンブラは出力しない。

### 18.9 ST の検査

次はエラーにする。

```asm
ST ACC, ACC
ST ACC, IX
ST ACC, 1
ST IX,  ACC
ST IX,  IX
ST IX,  1
```

正しい例:

```asm
ST ACC, [80H]
ST ACC, (80H)
ST IX,  [IX+10H]
ST IX,  (IX+10H)
```

### 18.10 branch label

```asm
LOOP:
  SUB IX, 1
  BP LOOP
```

`BP LOOP` は次に変換される。

```text
33 <absolute address of LOOP>
```

相対分岐ではない。

---

## 19. 逆アセンブラ仕様

### 19.1 alias 表示

`B=011` の即値 alias は、通常は canonical 表示に正規化する。

```text
63 12 -> LD ACC, 12H
6B 12 -> LD IX,  12H
```

必要なら verbose mode で alias を表示する。

```text
63 12 -> LD ACC, 12H ; alias opcode, B=011
```

### 19.2 undefined ST opcode

```text
70,71,72,73,78,79,7A,7B
```

は命令として表示せず、次のいずれかにする。

```asm
.db 70H
```

または

```asm
ILLEGAL 70H
```

### 19.3 HLT aliases

```text
08..0F
50..5F
```

は `HLT` と表示してよい。  
verbose mode では元 opcode を保持する。

---

## 20. コンパイラ設計上の制約

### 20.1 レジスタ

実用上使えるレジスタは `ACC` と `IX` の2本である。

| register | 推奨用途 |
|---|---|
| `ACC` | 式評価、ALU 主対象 |
| `IX` | loop counter, array index, pointer-like value |

### 20.2 メモリ

C コンパイラの通常変数は `data` 領域に置くのが自然である。

```asm
LD ACC, (var)
ST ACC, (var)
```

ただし、教材互換のアセンブリでは `program` 領域を変数置き場にする例があるため、エミュレータ・アセンブラは `[d]` の読み書きも完全対応する。

### 20.3 推奨 C サブセット

初期対応:

```c
uint8_t
int8_t
global variables
if
while
for
+ - & | ^
== != < <= > >=
arrays indexed by IX
```

後回し:

```c
function calls
recursion
stack frame
struct
general pointer arithmetic
int16_t
mul/div
```

### 20.4 16bit 加算

`ADD` は `CF` を更新しないため、多バイト加算には `RCF` + `ADC` を使う。

```asm
RCF
LD  ACC, (a_lo)
ADC ACC, (b_lo)
ST  ACC, (r_lo)

LD  ACC, (a_hi)
ADC ACC, (b_hi)
ST  ACC, (r_hi)
```

### 20.5 16bit 減算

`SUB` は `CF` を更新しないため、多バイト減算には `RCF` + `SBC` を使う。

```asm
RCF
LD  ACC, (a_lo)
SBC ACC, (b_lo)
ST  ACC, (r_lo)

LD  ACC, (a_hi)
SBC ACC, (b_hi)
ST  ACC, (r_hi)
```

---

## 21. テスト仕様

### 21.1 reset test

```text
after reset:
  ACC=IX=PC=IR=MAR=0
  CF=VF=NF=ZF=0
  halt=false
```

### 21.2 fetch test

program:

```text
00: 0F
```

after `P0`:

```text
MAR=00
PC=01
```

after `P1`:

```text
IR=0F
```

after `P2`:

```text
halt=true
```

### 21.3 LD reg direction test

program:

```asm
LD ACC, 01H
LD IX,  02H
LD ACC, IX
ST ACC, (00H)
ST IX,  (01H)
HLT
```

expected:

```text
data[00] = 02H
data[01] = 02H
```

このテストにより、`LD A,reg` が `A <- B` であることを検証する。

### 21.4 program memory write test

program:

```asm
EOR ACC, ACC
ST  ACC, [80H]
LD  ACC, 55H
ST  ACC, [80H]
LD  ACC, [80H]
ST  ACC, (00H)
HLT
```

expected:

```text
program[80H] = 55H
data[00H] = 55H
```

### 21.5 immediate alias test

manual program bytes:

```text
63 12 0F
```

meaning:

```asm
LD ACC, 12H
HLT
```

expected:

```text
ACC=12H
```

Assembler should emit `62 12`, not `63 12`.

### 21.6 branch absolute test

program:

```asm
BA target
LD ACC, 01H
target:
LD ACC, 02H
HLT
```

expected:

```text
ACC=02H
```

### 21.7 SBC borrow test

initial:

```text
ACC=03H
CF=0
```

program:

```asm
SBC ACC, 05H
HLT
```

expected:

```text
ACC=FEH
CF=1
NF=1
ZF=0
```

### 21.8 RLA through carry test

initial:

```text
ACC=80H
CF=1
```

program:

```asm
RLA ACC
HLT
```

expected:

```text
ACC=01H
CF=1
ZF=0
NF=0
VF=1
```

### 21.9 ADD does not modify CF

initial:

```text
ACC=FFH
CF=0
```

program:

```asm
ADD ACC, 01H
HLT
```

expected:

```text
ACC=00H
CF=0
ZF=1
```

### 21.10 CMP does not modify A or CF

initial:

```text
ACC=01H
CF=1
```

program:

```asm
CMP ACC, 02H
HLT
```

expected:

```text
ACC=01H
CF=1
NF=1
ZF=0
```

---

## 22. 既知の資料上の不整合と採用方針

### 22.1 `LD A,reg` のフェーズ表

マニュアルの命令実行フェーズ表では、`LD` の `ACC/IX` 行が

```text
(A) -> B
```

と読める。

しかし、命令セット表では `LD` の機能が

```text
(B) -> A
```

であり、opcode 表の `LD ACC,IX`, `LD IX,ACC` とも整合する。

本仕様では、命令セット表・opcode 表・サンプルコードを優先し、次を採用する。

```text
LD A,reg:
  A <- B
```

フェーズ表の当該セルは誤植とみなす。

### 22.2 CMP の `ALU -> A` 表記

フェーズ表では ALU 命令群に対して `ALU -> A` と読める箇所がある。

しかし、`CMP` は比較命令であり、命令意味として destination register を変更しない。  
本仕様では次を採用する。

```text
CMP:
  A - B により flags を更新
  A は変更しない
```

### 22.3 `Mem` の領域

フェーズ表では `Mem` とだけ書かれているが、アドレスモード表に従い、本仕様では次のように分ける。

```text
fetch and operand byte: program
[d], [IX+d]          : program
(d), (IX+d)          : data
```

---

## 23. 実装上の推奨分割

エミュレータ内部は次のように分けるとよい。

```text
decodeOpcode(opcode)
instructionLength(decoded)
readOperandByte()
resolveAddress(mode)
readOperand(mode)
writeOperand(mode)
executeAlu(op, lhs, rhs, cf)
executeShiftRotate(op, target, cf)
updateFlags()
stepPhase()
stepInstruction()
```

フェーズ正確性を保つため、`PC`, `MAR`, `IR` を省略しない。

---

## 24. 最小 decode 擬似コード

```ts
function decode(op: u8): DecodedInstruction {
  if ((op & 0xf8) === 0x00) return { kind: "NOP" };
  if ((op & 0xf8) === 0x08) return { kind: "HLT" };
  if ((op & 0xf0) === 0x50) return { kind: "HLT" };

  if ((op & 0xf8) === 0x10) return { kind: "OUT" };
  if ((op & 0xf8) === 0x18) return { kind: "IN" };
  if ((op & 0xf8) === 0x20) return { kind: "RCF" };
  if ((op & 0xf8) === 0x28) return { kind: "SCF" };

  if ((op & 0xf0) === 0x30) {
    return { kind: "Bcc", cc: op & 0x0f };
  }

  if ((op & 0xf0) === 0x40) {
    const a = (op >> 3) & 1;
    const q = (op >> 2) & 1;
    const sm = op & 3;
    return { kind: "ShiftRotate", a, q, sm };
  }

  const group = (op >> 4) & 0x0f;
  const a = (op >> 3) & 1;
  const b = op & 0x07;

  switch (group) {
    case 0x6: return { kind: "LD", a, b };
    case 0x7:
      if (b <= 0x3) return { kind: "ILLEGAL", opcode: op };
      return { kind: "ST", a, b };
    case 0x8: return { kind: "SBC", a, b };
    case 0x9: return { kind: "ADC", a, b };
    case 0xa: return { kind: "SUB", a, b };
    case 0xb: return { kind: "ADD", a, b };
    case 0xc: return { kind: "EOR", a, b };
    case 0xd: return { kind: "OR",  a, b };
    case 0xe: return { kind: "AND", a, b };
    case 0xf: return { kind: "CMP", a, b };
  }

  return { kind: "ILLEGAL", opcode: op };
}
```

---

## 25. 完了条件

エミュレータは次を満たせば、本仕様に対して合格とする。

1. 全 opcode `00..FF` を分類できる。
2. `00..07` を NOP として扱う。
3. `08..0F` と `50..5F` を HLT として扱う。
4. `10..17`, `18..1F`, `20..27`, `28..2F` の alias を正しく扱う。
5. `B=010` と `B=011` を即値として扱う。
6. アセンブラは即値を `B=010` で出力する。
7. `ST` の無効 opcode を illegal として扱う。
8. `LD A,reg` は `A <- B` とする。
9. `CMP` は destination register を変更しない。
10. `ADD/SUB/CMP` は `CF` を変更しない。
11. `ADC/SBC` は `CF` を入力・出力として使う。
12. `SBC` の `CF=1` は borrow 発生を表す。
13. `RLA/RRA` は `CF` 経由 rotate として実装する。
14. `[d]`, `[IX+d]` は program 領域を参照する。
15. `(d)`, `(IX+d)` は data 領域を参照する。
16. program 領域への `ST` を許可する。
17. `PC++`, `MAR <- PC` の同時性をフェーズ単位で再現する。
18. shift/rotate は `P2` で対象レジスタ、`P3` で flags を更新する。
19. `IN/OUT` は `P2/P3` の I/O flag 変化を再現する。
20. 分岐命令は常に2語命令で、条件不成立でも operand を消費する。

---
