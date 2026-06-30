// Orchestrator for `pnpm e2e:verify`: stand up the disposable Synapse + Caddy
// harness, run the two-context SAS verification, then tear everything down — even
// on failure. The dev build (www/) is produced by the package.json script before
// this runs. Use verify-sas.mjs directly to run against an already-running HS.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { start } from '../synapse/start.mjs';
import { stop } from '../synapse/stop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Node's fetch (used by the harness health polls) must accept Caddy's self-signed
// cert; relax verification for this orchestrator process only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function runNode(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, script)], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let exit = 1;
try {
  const hs = await start();
  exit = await runNode('../features/verify-sas.mjs', {
    TRINITY_HS: hs.hs,
    TRINITY_USER: hs.user,
    TRINITY_PASS: hs.pass,
  });
} catch (err) {
  console.error('[e2e:verify] harness error:', err.message ?? err);
} finally {
  await stop().catch(() => {});
}
process.exit(exit);
