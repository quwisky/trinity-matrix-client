// CI smoke: load the built addon in Electron-as-Node and ask for availability twice. A hosted
// runner has no Hello hardware, so any known availability string passes; a crash, a
// missing export or an unknown answer fails.
const path = require('node:path');

const addon = require(
  path.join(__dirname, '..', 'build', 'windows-hello.node'),
);
const known = new Set([
  'available',
  'device-not-present',
  'not-configured',
  'disabled-by-policy',
  'device-busy',
]);
if (
  typeof addon.availability !== 'function' ||
  typeof addon.verify !== 'function'
) {
  console.error('windows-hello.node lacks availability() or verify()');
  process.exit(1);
}
// Twice in sequence: each call enters and leaves the MTA on a reused pool thread while
// C++/WinRT caches the activation factory, and every unlock repeats the call.
async function main() {
  for (const attempt of [1, 2]) {
    const value = await addon.availability();
    if (!known.has(value)) {
      console.error(`unexpected availability (call ${attempt}): ${value}`);
      process.exit(1);
    }
    console.log(`windows-hello availability (call ${attempt}): ${value}`);
  }
}
main().catch(() => process.exit(1));
