#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };

// Nx 23 forces colour support into every task child. When a parent shell exports
// NO_COLOR, Node sees both variables in those children and emits one warning per
// worker even though Nx has already made NO_COLOR ineffective. Remove only that
// contradictory variable at the Nx process boundary; an explicit FORCE_COLOR is
// preserved, and command output otherwise behaves exactly as Nx currently chooses.
if (env.NO_COLOR !== undefined) {
  delete env.NO_COLOR;
}

const nxCli = fileURLToPath(
  new URL('../node_modules/nx/dist/bin/nx.js', import.meta.url),
);
const child = spawn(process.execPath, [nxCli, ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error('Unable to start the workspace Nx CLI', error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
