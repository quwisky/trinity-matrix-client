import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageGestureSettingsService,
  isSwipeAction,
} from './message-gesture-settings.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

const get = vi.mocked(Preferences.get);
const set = vi.mocked(Preferences.set);

function build(): MessageGestureSettingsService {
  return TestBed.configureTestingModule({}).inject(
    MessageGestureSettingsService,
  );
}

const KEY = 'trinity.message-swipe';

describe('MessageGestureSettingsService', () => {
  let stored: Record<string, string | null>;

  beforeEach(() => {
    stored = {};
    get
      .mockReset()
      .mockImplementation(({ key }) =>
        Promise.resolve({ value: stored[key] ?? null }),
      );
    set.mockReset().mockImplementation(({ key, value }) => {
      stored[key] = value;
      return Promise.resolve();
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not swipe until asked to', async () => {
    // The default is a decision, not an oversight — see the constant's docblock. A gesture
    // layered onto a scrolling timeline changes how the app answers a drag people already
    // make, and the conflicts it dodges are with recognisers no test can install.
    const service = build();
    await expect(service.init()).resolves.toEqual({ kind: 'ready' });

    expect(service.messageSwipe()).toBe('off');
  });

  it('restores a stored direction', async () => {
    stored[KEY] = 'left';
    const service = build();

    await service.init();

    expect(service.messageSwipe()).toBe('left');
  });

  it('ignores a stored value that is not a direction', async () => {
    // Storage is not a schema: a hand-edited preference, or one left by a build that offered
    // a fourth value, must not reach the gesture.
    stored[KEY] = 'diagonal';
    const service = build();

    await expect(service.init()).resolves.toEqual({
      kind: 'defaulted',
      reason: 'invalid-stored-value',
    });

    expect(service.messageSwipe()).toBe('off');
  });

  it('persists a change under the gesture key', () => {
    const service = build();

    service.setMessageSwipe('right');

    expect(service.messageSwipe()).toBe('right');
    expect(set).toHaveBeenCalledWith({ key: KEY, value: 'right' });
  });

  it('keeps the default when storage is unavailable', async () => {
    get.mockRejectedValue(new Error('no storage'));
    const service = build();

    await expect(service.init()).resolves.toEqual({
      kind: 'defaulted',
      reason: 'storage-unavailable',
    });

    expect(service.messageSwipe()).toBe('off');
  });

  it('accepts every offered direction and nothing else', () => {
    // The guard is what the config import holds a pasted value to, so it is asserted against
    // the catalogue rather than a restated list — the two cannot drift.
    const service = build();
    for (const { id } of service.swipeActions) {
      expect(isSwipeAction(id)).toBe(true);
    }

    expect(isSwipeAction('diagonal')).toBe(false);
    expect(isSwipeAction(null)).toBe(false);
    expect(isSwipeAction(undefined)).toBe(false);
  });
});
