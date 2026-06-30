// Static-serve the built www/ for Playwright's webServer, reusing the legacy
// harness's SPA-fallback server (serves the crypto WASM at /assets/crypto/, which
// in-app E2EE init needs). The dev build runs before this in the webServer command.
import { serve } from '../../support/serve.mjs';

const PORT = Number(process.env.PORT ?? 4200);
await serve('www', PORT);
console.log(`[e2e] serving www on http://localhost:${PORT}`);
