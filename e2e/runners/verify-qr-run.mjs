// Orchestrator for `pnpm e2e:verify:qr`: run the two-client QR verification
// against a disposable Synapse and always tear the harness down afterwards.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { start } from '../synapse/start.mjs';
import { stop } from '../synapse/stop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
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
  exit = await runNode('../features/verify-qr.mjs', {
    TRINITY_HS: hs.hs,
    TRINITY_USER: hs.user,
    TRINITY_PASS: hs.pass,
  });
} catch (err) {
  console.error('[e2e:verify:qr] harness error:', err.message ?? err);
} finally {
  await stop().catch(() => {});
}
process.exit(exit);
