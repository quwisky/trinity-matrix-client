import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'eu.qwky.trinity',
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
  },
};

export default config;
