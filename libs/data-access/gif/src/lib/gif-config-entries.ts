import { inject, type EnvironmentProviders } from '@angular/core';
import {
  choiceSetting,
  provideConfigEntries,
  textSetting,
  type ConfigEntry,
} from '@trinity/platform-native';
import {
  DEFAULT_GIF_PROVIDER,
  GifSettingsService,
} from './gif-settings.service';
import { GIF_PROVIDERS, isGifProviderId } from './gif.model';

/**
 * Upper bound on a pasted API key. Tenor and GIPHY keys are ~40 characters; this is well
 * past any of them and keeps a paste of something that is not a key out of the stored blob.
 */
const MAX_API_KEY_LENGTH = 200;

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
        description: 'Which GIF service the picker searches.',
        read: () => gif.provider(),
        reset: () => gif.save(DEFAULT_GIF_PROVIDER, gif.apiKey()),
        ...choiceSetting({
          isValid: isGifProviderId,
          options: GIF_PROVIDERS.map((provider) => provider.id),
          noun: 'a GIF provider Trinity can talk to',
          // Reads the key back out rather than carrying it: both fields share one blob, so
          // each setter has to rewrite the other's current value. Whichever of the two
          // entries applies second sees the first's result, so the pair converges.
          set: (value) => gif.save(value, gif.apiKey()),
        }),
      },
      {
        path: 'gif.apiKey',
        key: 'trinity.gif.config',
        description:
          'Your own API key for that GIF service, or empty to leave the picker switched off.',
        read: () => gif.apiKey(),
        reset: () => gif.clear(),
        ...textSetting({
          maxLength: MAX_API_KEY_LENGTH,
          set: (value) => gif.save(gif.provider(), value),
        }),
      },
    ] satisfies readonly ConfigEntry[];
  });
}
