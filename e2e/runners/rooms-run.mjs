// Orchestrator for `pnpm e2e:rooms`: stand up the disposable Synapse + Caddy
// harness, run the room/DM creation + invite lifecycle e2e, then tear everything
// down — even on failure. The dev build (www/) is produced before this runs.
//
// MUST run sequentially with other e2e scripts: all orchestrators share the one
// Synapse+Caddy docker stack (fixed ports 8008/8448 + ./data) and the single
// www/ build. Never run them concurrently. rooms.mjs serves on its own port
// (8130) to allow a decoupled-build future.
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
  exit = await runNode('../features/rooms.mjs', {
    TRINITY_HS: hs.hs,
    TRINITY_USER: hs.user,
    TRINITY_PASS: hs.pass,
  });
} catch (err) {
  console.error('[e2e:rooms] harness error:', err.message ?? err);
} finally {
  await stop().catch(() => {});
}
process.exit(exit);
