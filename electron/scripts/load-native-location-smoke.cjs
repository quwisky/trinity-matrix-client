const addonPath = process.argv.at(-1);
const addon = require(addonPath);

if (
  typeof addon.requestCurrentPosition !== 'function' ||
  typeof addon.cancelCurrentRequest !== 'function'
) {
  throw new Error('Packaged native-location addon has the wrong exports.');
}

process.exit(0);
