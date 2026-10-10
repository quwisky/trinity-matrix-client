import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.trinityproject.trinity',
  appName: 'Trinity',
  webDir: 'www',
  // Capacitor's bridge logs every plugin call's arguments (Android) and the start of every
  // result (iOS) to the device log, which includes access tokens and stored sessions. Keep
  // it off in every build, CI included; set TRINITY_CAPACITOR_LOGS=1 when running
  // `cap sync` for a local debugging build that needs the bridge and console logs.
  loggingBehavior:
    process.env['TRINITY_CAPACITOR_LOGS'] === '1' ? 'debug' : 'none',
  plugins: {
    // Chat app with a bottom-pinned composer: resize the whole native WebView when
    // the soft keyboard shows so `100dvh`/`vh` shrink and the composer rides up above
    // the keyboard instead of being covered. `native` is the default but pinned here
    // for intent (iOS honours `resize`; Android already resizes the WebView).
    Keyboard: {
      resize: 'native',
    },
    // Android status-bar icon for local notifications: white-only (Android tints it).
    LocalNotifications: {
      smallIcon: 'ic_stat_trinity',
      iconColor: '#5865F2',
    },
  },
};

export default config;
