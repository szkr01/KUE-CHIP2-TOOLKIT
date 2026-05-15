# KUE-CHIP2 Toolkit

KUE-CHIP2 用の TypeScript 製ツールキットです。

- アセンブラ
- 逆アセンブラ
- 命令単位 / フェーズ単位エミュレータ
- ブラウザ用プレイグラウンド
- レポート検証向け CLI

## セットアップ

```bash
npm install
npm run build
```

`index.html` と CLI は `dist/` のビルド結果を使います。ソースを変更した後は `npm run build` を実行してください。

## ブラウザで使う

`index.html` をブラウザで開くと、KUE-CHIP2 の簡易プレイグラウンドを使えます。

```bash
python3 -m http.server 8000
```

その後、ブラウザで次を開きます。

```text
http://localhost:8000/index.html
```

画面では次の操作ができます。

- `Assembly` にアセンブリを書く
- `Assemble` で機械語へ変換する
- `Run` で停止まで実行する
- `Step Inst` で1命令ずつ実行する
- `Step Phase` で P0 から P4 のフェーズ単位で実行する
- `Prog` / `Data` タブでメモリを見る
- CPUレジスタ、フラグ、メモリセルを直接編集する

## CLIで使う

ビルド後は `dist/cli.js` を直接実行できます。

```bash
node dist/cli.js --help
```

npm package としてリンクする場合は、`kue-chip2` コマンドとして使えます。

```bash
npm link
kue-chip2 --help
```

### アセンブル結果を見る

```bash
node dist/cli.js assemble div.asm
```

出力例:

```text
ADDR  BYTES   INSTRUCTION
00H   65 81   LD ACC, (81H)
02H   F2 00   CMP ACC, 00H
04H   39 1A   BZ 1AH
```

レポートに書いた機械語表や分岐先アドレスを確認する用途に使います。

### 実行してメモリを確認する

```bash
node dist/cli.js run div.asm \
  --data DATA1=0DH \
  --data DATA2=03H \
  --dump-data DATA1:4
```

`--data` はデータメモリ1バイトの初期値です。`--dump-data` は実行後に表示するデータメモリ範囲です。

出力例:

```text
STOPPED  halt
STEPS    32

REGISTERS
ACC  01H
IX   04H

DATA 80H:4
80H  0DH
81H  03H
82H  04H
83H  01H
```

この例では、`80H` から4バイトを見て、入力値、商、余りを手作業で確認できます。

### 命令トレースを見る

```bash
node dist/cli.js trace div.asm \
  --data DATA1=0DH \
  --data DATA2=03H \
  --dump-data DATA1:4
```

各命令の実行後の `ACC`, `IX`, `CF`, `VF`, `NF`, `ZF` を表示します。`SBC` 後に `CF=1` になるか、分岐がどこへ進むかを確認できます。

## ASMの例

```asm
DATA1: EQU 80H
DATA2: EQU 81H
ANS:   EQU 82H
REM:   EQU 83H

        LD  ACC, (DATA2)
        CMP ACC, 00H
        BZ  DIVZERO

        LD  ACC, (DATA1)
        LD  IX,  00H

LOOP:   RCF
        SBC ACC, (DATA2)
        BC  DONE

        ADD IX,  01H
        BA  LOOP

DONE:   ADD ACC, (DATA2)
        ST  IX,  (ANS)
        ST  ACC, (REM)
        HLT

DIVZERO:
        LD  IX,  FFH
        LD  ACC, (DATA1)
        ST  IX,  (ANS)
        ST  ACC, (REM)
        HLT
```

## 開発用コマンド

```bash
npm run typecheck
npm test
npm run build
```

## メモリ表記

エミュレータ内部では、プログラム領域とデータ領域をそれぞれ 256 バイトとして扱います。

```text
program[00H..FFH]
data[00H..FFH]
```

教材や説明では、データ領域を `100H..1FFH` と表示することがあります。その場合でも、ASM中の `(80H)` はデータ領域の `data[80H]` を指します。
