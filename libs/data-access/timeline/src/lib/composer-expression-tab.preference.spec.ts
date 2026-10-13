import { TestBed } from '@angular/core/testing';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
  type PreferenceStorageRequest,
} from '@trinity/runtime/preferences';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_EXPRESSION_TAB_PREFERENCE,
  ComposerExpressionTabPreference,
} from './composer-expression-tab.preference';

function setup(stored?: unknown) {
  const writes: PreferenceStorageRequest[] = [];
  const adapter: PreferenceStorageAdapter = {
    read: () =>
      of(
        stored === undefined
          ? { kind: 'missing' as const }
          : { kind: 'found' as const, payload: JSON.stringify(stored) },
      ),
    write: (request) => {
      writes.push(request);
      return of({ kind: 'completed' as const });
    },
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter }],
  });
  return {
    preference: TestBed.inject(ComposerExpressionTabPreference),
    writes,
  };
}

describe('COMPOSER_EXPRESSION_TAB_PREFERENCE', () => {
  it('is a device-local value kept out of the exported configuration', () => {
    expect(COMPOSER_EXPRESSION_TAB_PREFERENCE).toMatchObject({
      id: 'conversations.composer.expression-tab',
      owner: 'conversations',
      scope: 'installation',
      storage: 'device-preferences',
      export: 'excluded',
      defaultValue: 'emoji',
      editor: { kind: 'none' },
      persistence: { key: 'trinity.composer.expression-tab' },
    });
  });

  it('accepts the three tabs and rejects anything else', () => {
    for (const tab of ['gif', 'sticker', 'emoji']) {
      expect(COMPOSER_EXPRESSION_TAB_PREFERENCE.validate(tab).kind).toBe(
        'accepted',
      );
    }
    expect(COMPOSER_EXPRESSION_TAB_PREFERENCE.validate('sound').kind).toBe(
      'rejected',
    );
  });
});

describe('ComposerExpressionTabPreference', () => {
  it('reads Emoji before anything is stored', async () => {
    const { preference } = setup();
    await firstValueFrom(preference.restore());
    expect(preference.tab()).toBe('emoji');
  });

  it('restores the tab this device used last', async () => {
    const { preference } = setup({ version: 1, value: 'gif' });
    await firstValueFrom(preference.restore());
    expect(preference.tab()).toBe('gif');
  });

  it('keeps Emoji when the stored value is not a tab', async () => {
    const { preference } = setup({ version: 1, value: 'sound' });
    await firstValueFrom(preference.restore());
    expect(preference.tab()).toBe('emoji');
  });

  it('remembers a chosen tab under its own key', async () => {
    const { preference, writes } = setup();
    const outcome = await firstValueFrom(preference.remember('sticker'));
    expect(outcome.kind).toBe('completed');
    expect(preference.tab()).toBe('sticker');
    expect(writes.map((write) => write.key)).toEqual([
      'trinity.composer.expression-tab',
    ]);
  });
});
