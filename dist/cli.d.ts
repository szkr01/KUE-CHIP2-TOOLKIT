#!/usr/bin/env node
type Io = {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
};
declare function runCli(argv: string[], io?: Io): number;

export { runCli };
