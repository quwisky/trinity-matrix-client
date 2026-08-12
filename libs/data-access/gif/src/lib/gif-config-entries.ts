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
import {
  GIF_PROVIDERS,
  isGifProviderId,
  retiredGifProvider,
} from './gif.model';

/**
 * Upper bound on a pasted API key. KLIPY and GIPHY keys are ~40 characters; this is well
 * past any of them and keeps a paste of something that is not a key out of the stored blob.
 */
const MAX_API_KEY_LENGTH = 200;

/**
 * Accept a retired provider id and migrate it, instead of rejecting the document.
 *
 * Every configuration exported before Tenor was replaced contains `"provider": "tenor"`, so
 * the strict `choiceSetting` check would make a file produced by our own Export button fail
 * to import, naming a path the user cannot fix without hand-editing. The envelope carries a
 * `version` so a shape change is survivable; this is that survival. The value is rewritten
 * to the replacement and the reason is reported through the plan's warning channel, which
 * exists for exactly this — accepted, but worth explaining.
 *
 * It stays a CLOSED set to everything else, which is what `configSchemaDrift` checks: the
 * retired id is not offered in `choices`, so it is absent from the published JSON Schema and
 * the editor's completion list, and the "accepts a value outside its list" probe still fails
 * as it should. A retired id is accepted, never advertised.
 *
 * The key is deliberately not migrated with it — see {@link RETIRED_GIF_PROVIDERS}. The
 * `gif.apiKey` entry beside this one carries whatever the document says, so a document
 * written against Tenor lands on KLIPY with a key that cannot work; the warning is what tells
 * the user to replace it.
 */
function migrateRetired(
  setting: Pick<ConfigEntry, 'validate' | 'write' | 'type' | 'choices'>,
): Pick<ConfigEntry, 'validate' | 'write' | 'type' | 'choices'> {
  return {
    ...setting,
    validate: (value) => {
      const replacement = retiredGifProvider(value);
      return replacement
        ? {
            ok: true,
            value: replacement,
            warning: `${String(value)} is no longer a GIF provider Trinity can talk to, so this was read as ${replacement}. Your old key will not work with it — paste a new one in Settings → GIFs.`,
          }
        : setting.validate(value);
    },
    write: (value) => {
      const replacement = retiredGifProvider(value);
      setting.write(replacement ?? value);
    },
  };
}

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
        ...migrateRetired(
          choiceSetting({
            isValid: isGifProviderId,
            options: GIF_PROVIDERS.map((provider) => provider.id),
            noun: 'a GIF provider Trinity can talk to',
            // Reads the key back out rather than carrying it: both fields share one blob, so
            // each setter has to rewrite the other's current value. Whichever of the two
            // entries applies second sees the first's result, so the pair converges.
            set: (value) => gif.save(value, gif.apiKey()),
          }),
        ),
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
