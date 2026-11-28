/**
 * The native crypto bridge for Node: the crate's JSON-lines CLI as a child process. One
 * response line answers each request line, in order; a line holding an array is a batch.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const startCliBridge = (executable) => {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = [];
  let failure;
  const fail = (error) => {
    failure ??= error;
    for (const { reject } of waiting.splice(0)) reject(failure);
  };
  child.on('exit', (code, signal) =>
    fail(new Error(`trinity-crypto-cli exited (${signal ?? code})`)),
  );
  child.on('error', fail);
  child.stdin.on('error', fail);
  createInterface({ input: child.stdout }).on('line', (line) =>
    waiting.shift()?.resolve(line),
  );
  const send = (line) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      waiting.push({ resolve, reject });
      child.stdin.write(`${line}\n`);
    });
  return {
    call: send,
    callBatch: send,
    /** Kills the process, as a crash would. */
    kill: () => child.kill('SIGKILL'),
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null)
          return resolve();
        child.once('exit', () => resolve());
        child.stdin.end();
      }),
  };
};
