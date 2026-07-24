import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemLineSettingsService } from './system-line-settings.service';

const store = new Map<string, string>();
let failStorage = false;

// The service talks to @capacitor/preferences directly (the repo's preference pattern), so
// stub the plugin with an in-memory map rather than the whole native layer.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      if (failStorage) {
        throw new Error('storage unavailable');
      }
      return { value: store.get(key) ?? null };
    },
    set: async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    },
  },
}));

const MEMBERSHIP = 'trinity.timeline.show-membership';
const PROFILE = 'trinity.timeline.show-profile';
const ROOM = 'trinity.timeline.show-room-changes';

function make(): SystemLineSettingsService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [SystemLineSettingsService] });
  return TestBed.inject(SystemLineSettingsService);
}

describe('SystemLineSettingsService', () => {
  beforeEach(() => {
    store.clear();
    failStorage = false;
  });

  // Everything shown is today's behaviour, so an existing install must see no change until
  // the user opts out.
  it('shows every category by default', () => {
    const svc = make();

    expect(svc.showMembership()).toBe(true);
    expect(svc.showProfile()).toBe(true);
    expect(svc.showRoomChanges()).toBe(true);
  });

  it('toggles each category independently', () => {
    const svc = make();

    svc.setShowMembership(false);
    expect(svc.showMembership()).toBe(false);
    expect(svc.showProfile()).toBe(true);
    expect(svc.showRoomChanges()).toBe(true);

    svc.setShowProfile(false);
    svc.setShowRoomChanges(false);
    expect(svc.showProfile()).toBe(false);
    expect(svc.showRoomChanges()).toBe(false);
  });

  it('persists each toggle and restores it on the next launch', async () => {
    const first = make();
    first.setShowMembership(false);
    first.setShowRoomChanges(false);
    expect(store.get(MEMBERSHIP)).toBe('false');
    expect(store.get(ROOM)).toBe('false');

    const second = make();
    expect(second.showMembership()).toBe(true); // not hydrated yet
    await second.init();

    expect(second.showMembership()).toBe(false);
    expect(second.showRoomChanges()).toBe(false);
    expect(second.showProfile()).toBe(true); // never touched
  });

  it('keeps the defaults when nothing is stored', async () => {
    const svc = make();
    await svc.init();

    expect(svc.showMembership()).toBe(true);
    expect(svc.showProfile()).toBe(true);
    expect(svc.showRoomChanges()).toBe(true);
  });

  it('keeps the defaults when storage is unavailable', async () => {
    store.set(PROFILE, 'false');
    failStorage = true;
    const svc = make();
    await svc.init();

    // A read failure must not silently hide half the timeline.
    expect(svc.showProfile()).toBe(true);
  });
});
