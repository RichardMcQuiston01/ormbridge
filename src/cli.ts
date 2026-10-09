#!/usr/bin/env node
import { EXIT_CONVERSION_ERROR, runCli } from './cliRunner.js';

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
})
  .then((exitCode: number) => {
    process.exitCode = exitCode;
  })
  .catch((thrown: unknown) => {
    const message: string =
      thrown instanceof Error ? thrown.message : String(thrown);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = EXIT_CONVERSION_ERROR;
  });
