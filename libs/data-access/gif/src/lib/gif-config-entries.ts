import { inject, type EnvironmentProviders } from '@angular/core';
import {
  provideConfigEntries,
  type ConfigEntry,
} from '@trinity/platform-native';
import {
  DEFAULT_GIF_PROVIDER,
  GifSettingsService,
} from './gif-settings.service';

/**
 * The GIF picker's settings, for the config export.
 *
 * Both fields live in one stored blob, so each entry resets through the setter that
 * rewrites the whole blob. Order-independent by construction: whichever runs second sees
 * the other's result and still lands on provider = default, key = empty.
 *
 * The API key is exported. It is a third-party quota key the user typed and can already
 * read back in Settings — deliberately not in secure storage, which holds account
 * credentials — so leaving it out would make the export incomplete for the device-to-device
 * case it exists for. It is still someone's key: the Advanced section says the document
 * contains it before offering Copy.
 */
export function provideGifConfigEntries(): EnvironmentProviders {
  return provideConfigEntries(() => {
    const gif = inject(GifSettingsService);
    return [
      {
        path: 'gif.provider',
        key: 'trinity.gif.config',
        read: () => gif.provider(),
        reset: () => gif.save(DEFAULT_GIF_PROVIDER, gif.apiKey()),
      },
      {
        path: 'gif.apiKey',
        key: 'trinity.gif.config',
        read: () => gif.apiKey(),
        reset: () => gif.clear(),
      },
    ] satisfies readonly ConfigEntry[];
  });
}
