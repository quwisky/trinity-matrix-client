import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Router,
  RouterPreloader,
  provideRouter,
  withPreloading,
} from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreloadAfterFirstNavigation } from './preload-after-first-navigation.strategy';

@Component({ template: '' })
class StubPage {}

describe('PreloadAfterFirstNavigation', () => {
  afterEach(() => vi.useRealTimers());

  it('loads lazy routes on idle after the first navigation, not before', async () => {
    vi.useFakeTimers();
    const loadComponent = vi.fn(() => Promise.resolve(StubPage));
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: '', component: StubPage },
            { path: 'lazy', loadComponent },
          ],
          withPreloading(PreloadAfterFirstNavigation),
        ),
      ],
    });
    const router = TestBed.inject(Router);
    TestBed.inject(RouterPreloader).setUpPreloading();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(loadComponent).not.toHaveBeenCalled();

    await router.navigateByUrl('/');
    expect(loadComponent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(loadComponent).toHaveBeenCalledTimes(1);
  });

  describe('with requestIdleCallback', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('asks for a 2 s idle timeout and runs the load when it fires', () => {
      let idle: IdleRequestCallback | undefined;
      const request = vi.fn((callback: IdleRequestCallback) => {
        idle = callback;
        return 7;
      });
      vi.stubGlobal('requestIdleCallback', request);
      vi.stubGlobal('cancelIdleCallback', vi.fn());
      const load = vi.fn(() => of('loaded'));

      new PreloadAfterFirstNavigation().preload({}, load).subscribe();
      expect(load).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 2_000,
      });

      idle?.({ didTimeout: false, timeRemaining: () => 10 });
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('cancels the idle callback when unsubscribed, as the router does on destroy', () => {
      const cancel = vi.fn();
      vi.stubGlobal(
        'requestIdleCallback',
        vi.fn(() => 7),
      );
      vi.stubGlobal('cancelIdleCallback', cancel);
      const load = vi.fn(() => of('loaded'));

      new PreloadAfterFirstNavigation()
        .preload({}, load)
        .subscribe()
        .unsubscribe();

      expect(cancel).toHaveBeenCalledWith(7);
      expect(load).not.toHaveBeenCalled();
    });
  });
});
