import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppearanceEffects } from '@trinity/application/appearance';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import { CONVERSATION_ATTENTION } from '@trinity/data-access/timeline';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, of, tap, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appLockProviders, visibilityWhileLocked } from './app-lock.providers';

function setup(options: {
  hydrate: () => Observable<void>;
  status: 'off' | 'locked';
  applySaved?: () => Observable<void>;
}) {
  const status = signal<'unknown' | 'off' | 'locked'>('unknown');
  const applySaved = vi.fn(options.applySaved ?? (() => of(undefined)));
  TestBed.configureTestingModule({
    providers: [
      appLockProviders(),
      MockProvider(AppLockService, {
        status: status.asReadonly() as never,
        // The service decides as hydration completes.
        hydrate: () =>
          options
            .hydrate()
            .pipe(tap({ complete: () => status.set(options.status) })),
      }),
      MockProvider(AppearanceEffects, { applySaved }),
    ],
  });
  return { applySaved };
}

describe('appLockProviders', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves the lock state before the first render', async () => {
    const hydrated = new Subject<void>();
    TestBed.configureTestingModule({
      providers: [
        appLockProviders(),
        MockProvider(AppLockService, {
          hydrate: () => hydrated,
          status: signal('off').asReadonly() as never,
        }),
        MockProvider(AppearanceEffects, { applySaved: () => of(undefined) }),
      ],
    });
    const init = TestBed.inject(ApplicationInitStatus);
    let done = false;
    void init.donePromise.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    hydrated.next();
    hydrated.complete();
    await init.donePromise;
    expect(done).toBe(true);
  });

  it('paints a locked start in the saved appearance before the first render', async () => {
    const saved = new Subject<void>();
    const hydrated = new Subject<void>();
    const { applySaved } = setup({
      hydrate: () => hydrated,
      status: 'locked',
      applySaved: () => saved,
    });
    const init = TestBed.inject(ApplicationInitStatus);
    let done = false;
    void init.donePromise.then(() => (done = true));
    hydrated.complete();
    await Promise.resolve();
    expect(applySaved).toHaveBeenCalledOnce();
    expect(done).toBe(false);
    saved.next();
    saved.complete();
    await init.donePromise;
    expect(done).toBe(true);
  });

  it('does not wait more than half a second for the saved appearance', async () => {
    // RxJS `timeout` schedules through `setInterval`: fake it too, so the bound is pinned in
    // fake time rather than passing on real time.
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    });
    const hydrated = new Subject<void>();
    const { applySaved } = setup({
      hydrate: () => hydrated,
      status: 'locked',
      applySaved: () => NEVER,
    });
    const init = TestBed.inject(ApplicationInitStatus);
    let done = false;
    void init.donePromise.then(() => (done = true));
    hydrated.complete();
    await vi.advanceTimersByTimeAsync(499);
    expect(applySaved).toHaveBeenCalledOnce();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await init.donePromise;
    expect(done).toBe(true);
  });

  it('starts even if the saved appearance cannot be read', async () => {
    setup({
      hydrate: () => of(undefined),
      status: 'locked',
      applySaved: () => {
        throw new Error('storage');
      },
    });
    await expect(
      TestBed.inject(ApplicationInitStatus).donePromise,
    ).resolves.toBeUndefined();
  });

  it('leaves the appearance to the usual startup when nothing is locked', async () => {
    const { applySaved } = setup({
      hydrate: () => of(undefined),
      status: 'off',
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    expect(applySaved).not.toHaveBeenCalled();
  });
});

describe('visibilityWhileLocked', () => {
  const open = {
    foreground: true,
    hidden: false,
    conversation: { accountId: '@me:hs', roomId: '!r:hs' },
  };

  it('treats a locked app as nobody looking, so the open room still notifies', () => {
    expect(visibilityWhileLocked(open, true)).toEqual({
      foreground: false,
      hidden: false,
      conversation: null,
    });
    expect(visibilityWhileLocked(open, false)).toBe(open);
  });
});

describe('conversation attention', () => {
  afterEach(() => TestBed.resetTestingModule());

  function attentionFor(status: AppLockStatus) {
    const state = signal<AppLockStatus>(status);
    TestBed.configureTestingModule({
      providers: [
        appLockProviders(),
        MockProvider(AppLockService, {
          hydrate: () => of(undefined),
          status: state.asReadonly() as never,
        }),
        MockProvider(AppearanceEffects, { applySaved: () => of(undefined) }),
      ],
    });
    return { state, attention: TestBed.inject(CONVERSATION_ATTENTION) };
  }

  it('follows the lock', () => {
    const { state, attention } = attentionFor('locked');
    expect(attention.attentive()).toBe(false);
    state.set('unlocked');
    expect(attention.attentive()).toBe(true);
    state.set('locked');
    expect(attention.attentive()).toBe(false);
    state.set('off');
    expect(attention.attentive()).toBe(true);
  });

  it('fails closed until the lock state is known', () => {
    const { state, attention } = attentionFor('unknown');
    expect(attention.attentive()).toBe(false);
    state.set('off');
    expect(attention.attentive()).toBe(true);
  });
});
