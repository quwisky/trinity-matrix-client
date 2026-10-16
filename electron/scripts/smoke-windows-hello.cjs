// CI smoke: load the built addon in Electron-as-Node and ask for availability twice. A hosted
// runner has no Hello hardware, so any known availability string passes; a crash, a
// missing export or an unknown answer fails. Then the compiled main-process loader
// (dist/windows-hello.js, development path) must find the same addon.
const os = require('node:os');
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
  const hello = require(path.join(__dirname, '..', 'dist', 'windows-hello.js'));
  const loaded = hello.loadWindowsHello({
    packaged: false,
    resourcesPath: '',
    require,
  });
  const support = await hello
    .windowsHelloDriver(loaded, hello.windowsBuild(os.release()))
    .support();
  console.log(
    `windows-hello support on ${os.release()}: ${JSON.stringify(support)}`,
  );
  if (
    support.kind === 'unavailable' &&
    support.reason === 'addon-unavailable'
  ) {
    console.error('dist/windows-hello.js could not load the addon');
    process.exit(1);
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
