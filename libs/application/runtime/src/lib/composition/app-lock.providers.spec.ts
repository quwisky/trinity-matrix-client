import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppearanceEffects } from '@trinity/application/appearance';
import { AppLockService } from '@trinity/data-access/app-lock';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, of, tap, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appLockProviders } from './app-lock.providers';

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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
