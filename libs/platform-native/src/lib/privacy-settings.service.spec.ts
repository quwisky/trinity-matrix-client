import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import {
  definePreference,
  type PreferenceDescriptor,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { provideCapacitorPreferenceStorage } from './preferences/capacitor-preference-storage.adapter';
import {
  PrivacySettingsService,
  providePrivacyPreferenceSet,
  type PrivacyPreferenceSet,
} from './privacy-settings.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;
const values = new Map<string, string>();

const READ_RECEIPTS_KEY = 'trinity.privacy.send-read-receipts';
const LINK_PREVIEWS_KEY = 'trinity.privacy.link-previews';
const ENCRYPTED_PREVIEWS_KEY = 'trinity.privacy.link-previews-encrypted';

function testPreference(
  id: string,
  key: string,
  defaultValue: boolean,
): PreferenceDescriptor<boolean> {
  return definePreference({
    id,
    owner: 'conversations',
    section: 'privacy',
    order: 0,
    scope: 'installation',
    defaultValue,
    sensitivity: 'private',
    storage: 'device-preferences',
    export: 'portable',
    editor: { kind: 'none' },
    persistence: {
      key,
      migration: {
        currentVersion: 1,
        migrate: (stored: StoredPreference) => {
          if (typeof stored.value === 'boolean') {
            return { kind: 'accepted' as const, value: stored.value };
          }
          if (stored.version === 0 && stored.value === 'true') {
            return { kind: 'accepted' as const, value: true };
          }
          if (stored.version === 0 && stored.value === 'false') {
            return { kind: 'accepted' as const, value: false };
          }
          return {
            kind: 'rejected' as const,
            diagnostic: { code: 'invalid-test-boolean' },
          };
        },
      },
    },
    validate: (value) =>
      typeof value === 'boolean'
        ? { kind: 'accepted', value }
        : {
            kind: 'rejected',
            diagnostic: { code: 'invalid-test-boolean' },
          },
  });
}

const TEST_PRIVACY_PREFERENCES: PrivacyPreferenceSet = {
  sendReadReceipts: testPreference(
    'conversations.test.send-read-receipts',
    READ_RECEIPTS_KEY,
    true,
  ),
  linkPreviews: testPreference(
    'conversations.test.link-previews',
    LINK_PREVIEWS_KEY,
    true,
  ),
  linkPreviewsInEncrypted: testPreference(
    'conversations.test.link-previews-encrypted',
    ENCRYPTED_PREVIEWS_KEY,
    false,
  ),
};

describe('PrivacySettingsService preference facade', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    values.clear();
    get
      .mockReset()
      .mockImplementation(({ key }: { key: string }) =>
        Promise.resolve({ value: values.get(key) ?? null }),
      );
    set
      .mockReset()
      .mockImplementation(({ key, value }: { key: string; value: string }) => {
        values.set(key, value);
        return Promise.resolve();
      });
  });

  function service(): PrivacySettingsService {
    TestBed.configureTestingModule({
      providers: [
        provideCapacitorPreferenceStorage(),
        providePrivacyPreferenceSet(TEST_PRIVACY_PREFERENCES),
      ],
    });
    return TestBed.inject(PrivacySettingsService);
  }

  it('exposes catalog defaults before hydration', () => {
    const svc = service();

    expect(svc.sendReadReceipts()).toBe(true);
    expect(svc.linkPreviews()).toBe(true);
    expect(svc.linkPreviewsInEncrypted()).toBe(false);
  });

  it('hydrates all three preferences through one finite command', async () => {
    values.set(READ_RECEIPTS_KEY, 'false');
    values.set(LINK_PREVIEWS_KEY, 'false');
    values.set(ENCRYPTED_PREVIEWS_KEY, 'true');
    const svc = service();

    await expect(firstValueFrom(svc.init())).resolves.toEqual({
      kind: 'ready',
      hydrated: 3,
    });
    expect(svc.sendReadReceipts()).toBe(false);
    expect(svc.linkPreviews()).toBe(false);
    expect(svc.linkPreviewsInEncrypted()).toBe(true);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('migrates legacy booleans into versioned envelopes', async () => {
    values.set(READ_RECEIPTS_KEY, 'false');
    const svc = service();

    await firstValueFrom(svc.init());

    expect(set).toHaveBeenCalledWith({
      key: READ_RECEIPTS_KEY,
      value: '{"version":1,"value":false}',
    });
  });

  it('keeps safe defaults and reports recoverable storage failure', async () => {
    get.mockRejectedValue(new Error('contains access_token=secret'));
    const svc = service();

    const outcome = await firstValueFrom(svc.init());

    expect(outcome.kind).toBe('partial');
    expect(JSON.stringify(outcome)).not.toContain('access_token');
    expect(svc.sendReadReceipts()).toBe(true);
  });

  it('keeps writes cold and publishes only after persistence succeeds', async () => {
    const svc = service();
    const command = svc.setSendReadReceipts(false);

    expect(svc.sendReadReceipts()).toBe(true);
    expect(set).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(svc.sendReadReceipts()).toBe(false);
    expect(set).toHaveBeenCalledWith({
      key: READ_RECEIPTS_KEY,
      value: '{"version":1,"value":false}',
    });
  });

  it('preserves the current value on persistence failure', async () => {
    set.mockRejectedValue(new Error('write failed'));
    const svc = service();

    await expect(firstValueFrom(svc.setLinkPreviews(false))).resolves.toEqual({
      kind: 'unavailable',
      recovery: 'retry-storage',
      diagnostic: { code: 'preference-storage-write-failed' },
    });
    expect(svc.linkPreviews()).toBe(true);
  });
});
