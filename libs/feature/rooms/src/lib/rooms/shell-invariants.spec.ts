import {
  Component,
  DestroyRef,
  Injectable,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { runWithBusy, type BusyState } from '@trinity/ui';
import { throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';

/**
 * The two framework behaviours the #62 decomposition rests on, pinned before anything
 * moves.
 *
 * Neither is covered by `rooms.page.spec.ts`, and the second one is worse than uncovered:
 * that spec builds the page with `TestBed.inject(RoomsPage)` and never renders it, so the
 * page's `effect()` is created without a `ViewContext` and never runs. Its assertions that
 * no extra toast appeared therefore pass because nothing executes, not because the
 * behaviour holds. Both suites below render a real component so the effects actually run.
 */

/** Registers its teardown through the DestroyRef it was injected with. */
@Injectable()
class PageScopedService {
  readonly destroyed = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroyed.set(true));
  }
}

@Injectable({ providedIn: 'root' })
class RootScopedService {
  readonly destroyed = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroyed.set(true));
  }
}

@Component({ template: '', providers: [PageScopedService] })
class ScopeHostComponent {
  readonly pageScoped = inject(PageScopedService);
  readonly rootScoped = inject(RootScopedService);
}

describe('page-scoped providers own the component lifetime', () => {
  // Why this matters: `runWithBusy` pipes through `takeUntilDestroyed(state.destroyRef)`
  // and RoomsPage passes its own DestroyRef at 29 call sites. Every existing service in
  // this library is `providedIn: 'root'`. Moving those calls into a root-provided
  // coordinator would leak every one of those subscriptions past page teardown, and no
  // assertion in the existing suite would notice.
  it('fires a provided service teardown when the host is destroyed', () => {
    const fixture = TestBed.createComponent(ScopeHostComponent);
    fixture.detectChanges();
    const service = fixture.componentInstance.pageScoped;

    expect(service.destroyed()).toBe(false);
    fixture.destroy();

    expect(service.destroyed()).toBe(true);
  });

  it('does not fire a root-provided service teardown when the host is destroyed', () => {
    const fixture = TestBed.createComponent(ScopeHostComponent);
    fixture.detectChanges();
    const service = fixture.componentInstance.rootScoped;

    fixture.destroy();

    // The contrast is the point: a root-provided coordinator outlives the page, so
    // anything tied to its DestroyRef is never torn down.
    expect(service.destroyed()).toBe(false);
  });
});

/**
 * The error channel as the page builds it today: one writable error signal fed by
 * `runWithBusy`, and exactly one effect reading it.
 */
@Component({ template: '' })
class ErrorChannelHostComponent {
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly toasts: string[] = [];

  readonly state: BusyState = {
    busy: this.busy,
    error: this.error,
    destroyRef: inject(DestroyRef),
  };

  constructor() {
    effect(() => {
      const message = this.error();
      if (message) {
        this.toasts.push(message);
      }
    });
  }

  fail(message: string): void {
    runWithBusy(
      throwError(() => new Error(message)),
      this.state,
    ).subscribe();
  }
}

describe('one error channel produces one toast per flush', () => {
  // Why this matters: `spaceBusy`/`spaceError` look like space state but are read across
  // four of the five handler clusters, and a single effect toasts on them. Giving each
  // extracted coordinator its own pair would turn one effect into N. The dedupe below is
  // the property that would silently break.
  it('toasts once for two failures that land in the same flush', () => {
    const fixture = TestBed.createComponent(ErrorChannelHostComponent);
    fixture.detectChanges();
    const host = fixture.componentInstance;
    host.toasts.length = 0;

    host.fail('first');
    host.fail('second');
    fixture.detectChanges();

    // A signal read in an effect sees only the latest value per flush, so two failures
    // in one turn surface as one toast carrying the second message.
    expect(host.toasts).toEqual(['second']);
  });

  it('toasts twice for two failures in separate flushes', () => {
    const fixture = TestBed.createComponent(ErrorChannelHostComponent);
    fixture.detectChanges();
    const host = fixture.componentInstance;
    host.toasts.length = 0;

    host.fail('first');
    fixture.detectChanges();
    host.fail('second');
    fixture.detectChanges();

    expect(host.toasts).toEqual(['first', 'second']);
  });

  it('clears the error before each run, so an identical failure toasts again', () => {
    const fixture = TestBed.createComponent(ErrorChannelHostComponent);
    fixture.detectChanges();
    const host = fixture.componentInstance;
    host.toasts.length = 0;

    host.fail('same');
    fixture.detectChanges();
    host.fail('same');
    fixture.detectChanges();

    // `runWithBusy` nulls `error` synchronously at call time, so the signal changes
    // value twice and the effect re-runs. Without that reset the second failure would
    // be swallowed as a no-op write.
    expect(host.toasts).toEqual(['same', 'same']);
  });
});
