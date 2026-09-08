import type { CapacitorConfig } from '@capacitor/cli';
import { dependencies, devDependencies } from './package.json';

const config: CapacitorConfig = {
  appId: 'eu.qwky.trinity',
  appName: 'Trinity',
  webDir: 'www',
  android: {
    // Trinity serializes launcher badge writes with background push delivery.
    // Preserve Capacitor's dependency discovery, excluding the competing adapter.
    includePlugins: [
      ...Object.keys(dependencies),
      ...Object.keys(devDependencies),
    ].filter((name) => name !== '@capawesome/capacitor-badge'),
  },
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
