// CI smoke: load the built addon in Electron-as-Node and ask for availability. A hosted
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
addon
  .availability()
  .then((value) => {
    if (!known.has(value)) {
      console.error(`unexpected availability: ${value}`);
      process.exit(1);
    }
    console.log(`windows-hello availability: ${value}`);
  })
  .catch(() => process.exit(1));
