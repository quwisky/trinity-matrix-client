import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'eu.qwky.trinity',
  appName: 'Trinity',
  webDir: 'www',
  // Never send Capacitor bridge logs to the system log, in debug or release
  // builds. Capacitor otherwise logs every plugin call with its arguments,
  // secure-storage writes of the Matrix access token included, and forwards
  // app console output to logcat and the Xcode console.
  loggingBehavior: 'none',
  plugins: {
    // Chat app with a bottom-pinned composer: resize the whole native WebView when
    // the soft keyboard shows so `100dvh`/`vh` shrink and the composer rides up above
    // the keyboard instead of being covered. `native` is the default but pinned here
    // for intent (iOS honours `resize`; Android already resizes the WebView).
    Keyboard: {
      resize: 'native',
    },
  },
};

export default config;
