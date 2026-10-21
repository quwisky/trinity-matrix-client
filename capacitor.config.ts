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
  // The app scrolls inside its own panes, never the WebView itself. Pinning the WebView's
  // scroll view also stops WebKit scrolling the page to reveal a field under the iOS keyboard
  // (the keyboard plugin keeps its offset at zero).
  ios: {
    scrollEnabled: false,
  },
  plugins: {
    // `resize` is iOS-only; Android keeps resizing the WebView itself. iOS's `native`
    // mode resizes the WebView in one step after the keyboard has finished sliding, so the
    // app jumps and flickers. With `none` the WebView stays full height and the app shrinks
    // itself in step with the keyboard (NativeKeyboardInsetAdapter, `--trinity-keyboard-inset`).
    Keyboard: {
      resize: 'none',
    },
    // Android status-bar icon for local notifications: white-only (Android tints it).
    LocalNotifications: {
      smallIcon: 'ic_stat_trinity',
      iconColor: '#5865F2',
    },
  },
};

export default config;
