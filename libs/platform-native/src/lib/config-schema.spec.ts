import { describe, expect, it } from 'vitest';
import {
  CONFIG_EXCLUSION_NOTES,
  CONFIG_EXPORT_VERSION,
  CONFIG_KEY_LEDGER,
  exportedKeysFor,
} from './config-schema';

describe('config key ledger', () => {
  it('classifies each key exactly once', () => {
    const keys = CONFIG_KEY_LEDGER.map((record) => record.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every key it keeps out a reason someone can read', () => {
    for (const record of CONFIG_KEY_LEDGER) {
      if (record.disposition === 'exported') {
        continue;
      }
      // A reason is what makes the exclusion reviewable — an empty one would type-check
      // and tell the next person nothing about why the key is not in their export.
      expect(record.reason.length, record.key).toBeGreaterThan(40);
    }
  });

  it('keeps the four settled exclusions out, whatever else changes', () => {
    const dispositions = new Map(
      CONFIG_KEY_LEDGER.map((record) => [record.key, record.disposition]),
    );

    expect(dispositions.get('trinity.composer.drafts')).toBe('excluded');
    expect(dispositions.get('trinity.push.applied-app-id')).toBe('excluded');
    expect(dispositions.get('trinity.accounts.mixed')).toBe('excluded');
    expect(dispositions.get('trinity.spaces.order.default.')).toBe('excluded');
    expect(dispositions.get('trinity.spaces.order.overrides.')).toBe(
      'excluded',
    );
  });

  it('has data-access/rooms contributing nothing at all', () => {
    // Both of its keys are per-account and user-id-suffixed, so the lib registers no
    // entries. If that changes, the entries and this expectation move together.
    expect(exportedKeysFor('data-access/rooms')).toEqual([]);
  });

  it('names each owning lib for the keys it exports', () => {
    expect(exportedKeysFor('data-access/gif')).toEqual(['trinity.gif.config']);
    expect(exportedKeysFor('data-access/notifications')).toEqual([
      'trinity.push.gateway',
    ]);
    expect(exportedKeysFor('platform-native')).toHaveLength(19);
  });

  it('tells the user what the export leaves out, starting with their accounts', () => {
    // Decision 2: the section's copy must say this is a preferences transfer, not a
    // sign-in transfer. These notes are that copy.
    expect(CONFIG_EXCLUSION_NOTES.length).toBeGreaterThanOrEqual(4);
    expect(
      CONFIG_EXCLUSION_NOTES.some((note) =>
        note.reason.includes('not a sign-in transfer'),
      ),
    ).toBe(true);
  });

  it('starts the export format at version 1', () => {
    expect(CONFIG_EXPORT_VERSION).toBe(1);
  });
});
