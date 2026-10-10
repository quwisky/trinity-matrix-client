import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { HostLifecycleService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_RELEASE_DELAY_MS,
  BackgroundMemoryRelease,
} from './background-memory-release.service';

describe('BackgroundMemoryRelease', () => {
  const events = new Subject<
    { readonly kind: 'active' } | { readonly kind: 'background' }
  >();
  const media = { releaseUnpinned: vi.fn() };
  const avatars = { releaseUnpinned: vi.fn() };
  const conversations = { retireRetained: vi.fn() };
  const hostRelease = vi.fn(() => of({ kind: 'completed' as const }));
  const handleError = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        MockProvider(HostLifecycleService, {
          events,
          releaseMemory: hostRelease,
        }),
        MockProvider(MediaService, media),
        MockProvider(AvatarService, avatars),
        MockProvider(ConversationRuntime, conversations),
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  const released = () => [
    media.releaseUnpinned.mock.calls.length,
    avatars.releaseUnpinned.mock.calls.length,
    conversations.retireRetained.mock.calls.length,
    hostRelease.mock.calls.length,
  ];

  it('releases unpinned media, avatars, retained conversations and host caches after the delay', () => {
    const run = TestBed.inject(BackgroundMemoryRelease).run().subscribe();

    events.next({ kind: 'background' });
    vi.advanceTimersByTime(BACKGROUND_RELEASE_DELAY_MS - 1);
    expect(released()).toEqual([0, 0, 0, 0]);

    vi.advanceTimersByTime(1);
    expect(released()).toEqual([1, 1, 1, 1]);
    run.unsubscribe();
  });

  it('cancels the release when the app comes back first', () => {
    const run = TestBed.inject(BackgroundMemoryRelease).run().subscribe();

    events.next({ kind: 'background' });
    vi.advanceTimersByTime(BACKGROUND_RELEASE_DELAY_MS / 2);
    events.next({ kind: 'active' });
    vi.advanceTimersByTime(BACKGROUND_RELEASE_DELAY_MS * 2);

    expect(released()).toEqual([0, 0, 0, 0]);
    run.unsubscribe();
  });

  it('survives a failing release and releases again on the next background', () => {
    const error = vi.fn();
    const run = TestBed.inject(BackgroundMemoryRelease)
      .run()
      .subscribe({ error });
    const failure = new Error('release failed');
    conversations.retireRetained.mockImplementationOnce(() => {
      throw failure;
    });

    events.next({ kind: 'background' });
    vi.advanceTimersByTime(BACKGROUND_RELEASE_DELAY_MS);
    events.next({ kind: 'active' });
    events.next({ kind: 'background' });
    vi.advanceTimersByTime(BACKGROUND_RELEASE_DELAY_MS);

    expect(error).not.toHaveBeenCalled();
    expect(handleError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(conversations.retireRetained).toHaveBeenCalledTimes(2);
    expect(hostRelease).toHaveBeenCalledTimes(2);
    run.unsubscribe();
  });
});
