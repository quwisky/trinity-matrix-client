import { describe, expect, it } from 'vitest';
import { effectiveNotificationText } from './notification-text-policy';
import type { NotificationText } from './app-lock.preferences';

const phone = { known: true, enabled: true, lockScreenOffered: true } as const;
const desktop = { ...phone, lockScreenOffered: false } as const;

describe('effectiveNotificationText', () => {
  it.each<NotificationText>(['show', 'hide-on-lock-screen', 'always-hide'])(
    'is the choice %s while App lock is on, on a phone',
    (choice) => {
      expect(effectiveNotificationText({ ...phone, choice })).toBe(choice);
    },
  );

  it.each<NotificationText>(['show', 'hide-on-lock-screen', 'always-hide'])(
    'is Show while App lock is off, whatever the choice (%s)',
    (choice) => {
      expect(
        effectiveNotificationText({ ...phone, enabled: false, choice }),
      ).toBe('show');
    },
  );

  it('reads a lock-screen choice as Always hide on a desktop', () => {
    expect(
      effectiveNotificationText({ ...desktop, choice: 'hide-on-lock-screen' }),
    ).toBe('always-hide');
    expect(effectiveNotificationText({ ...desktop, choice: 'show' })).toBe(
      'show',
    );
  });

  it.each([true, false])(
    'hides everything until the settings are known (App lock on: %s)',
    (enabled) => {
      expect(
        effectiveNotificationText({
          ...phone,
          known: false,
          enabled,
          choice: 'show',
        }),
      ).toBe('always-hide');
    },
  );
});
