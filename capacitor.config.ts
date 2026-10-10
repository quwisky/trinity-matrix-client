import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.trinityproject.trinity',
  appName: 'Trinity',
  webDir: 'www',
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
