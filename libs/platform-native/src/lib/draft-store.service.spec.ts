import { TestBed } from '@angular/core/testing';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { Preferences } from '@capacitor/preferences';
import { DraftStoreService } from './draft-store.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;
const KEY = 'trinity.composer.drafts';

describe('DraftStoreService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  function service(): DraftStoreService {
    TestBed.configureTestingModule({ providers: [DraftStoreService] });
    return TestBed.inject(DraftStoreService);
  }

  it('returns an empty draft for an unknown conversation', () => {
    expect(service().get('!a:hs')).toBe('');
  });

  it('stores and reads back a draft', () => {
    const svc = service();
    svc.set('!a:hs', 'half a message');
    expect(svc.get('!a:hs')).toBe('half a message');
    expect(svc.get('!b:hs')).toBe(''); // isolated per conversation
  });

  it('drops the draft when set to blank', () => {
    const svc = service();
    svc.set('!a:hs', 'text');
    svc.set('!a:hs', '   ');
    expect(svc.get('!a:hs')).toBe('');
  });

  it('clears a draft', () => {
    const svc = service();
    svc.set('!a:hs', 'text');
    svc.clear('!a:hs');
    expect(svc.get('!a:hs')).toBe('');
  });

  it('loads persisted drafts on init', async () => {
    get.mockResolvedValue({
      value: JSON.stringify({ '!a:hs': 'saved draft', bad: 42 }),
    });
    const svc = service();

    await svc.init();

    expect(svc.get('!a:hs')).toBe('saved draft');
    expect(svc.get('bad')).toBe(''); // non-string entry ignored
  });

  it('starts empty when nothing (or corrupt data) is stored', async () => {
    get.mockResolvedValue({ value: 'not json' });
    const svc = service();

    await svc.init();

    expect(svc.get('!a:hs')).toBe('');
  });

  it('debounces persistence into a single coalesced write', () => {
    const svc = service();
    svc.set('!a:hs', 'a');
    svc.set('!a:hs', 'ab');
    svc.set('!b:hs', 'c');
    expect(set).not.toHaveBeenCalled(); // nothing written yet

    vi.advanceTimersByTime(400);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      key: KEY,
      value: JSON.stringify({ '!a:hs': 'ab', '!b:hs': 'c' }),
    });
  });

  // Issue #31. Both of these are about a debounced write outliving whatever asked for it.
  // Together they turned a green suite into a non-zero exit: the timer fired after the test
  // file's module was torn down, `Preferences.set` was no longer a promise, and `.catch` on
  // undefined threw out of a timer callback where nothing could catch it.
  describe('a pending write that outlives its caller', () => {
    it('does not fire after the injector is destroyed', () => {
      const svc = service();
      svc.set('!a:hs', 'half a message');

      TestBed.resetTestingModule(); // destroys the injector -> ngOnDestroy
      vi.advanceTimersByTime(1000);

      expect(set).not.toHaveBeenCalled();
    });

    it('survives a Preferences.set that does not return a promise', () => {
      // Exactly what a torn-down module hands back — and what used to crash the run.
      set.mockReturnValue(undefined);
      const svc = service();
      svc.set('!a:hs', 'half a message');

      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(set).toHaveBeenCalled();
    });

    it('still coalesces and writes normally when nothing is torn down', () => {
      const svc = service();
      svc.set('!a:hs', 'one');
      svc.set('!b:hs', 'two');
      vi.advanceTimersByTime(1000);

      expect(set).toHaveBeenCalledTimes(1);
      expect(JSON.parse(set.mock.calls[0][0].value)).toEqual({
        '!a:hs': 'one',
        '!b:hs': 'two',
      });
    });
  });
});
