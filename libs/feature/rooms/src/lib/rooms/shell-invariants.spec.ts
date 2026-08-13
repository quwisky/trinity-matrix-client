import {
  Component,
  DestroyRef,
  Injectable,
  effect,
  inject,
  signal,
  type Type,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { RoomsPage } from './rooms.page';
import { runWithBusy } from '@trinity/ui';
import { throwError } from 'rxjs';
import { MockProvider } from 'ng-mocks';
import { TrnToastService } from '@trinity/helm/overlay';
import { describe, expect, it } from 'vitest';
import { RoomShellStore } from './room-shell-store';
import { ShellStatusService } from './shell-status.service';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { AccountRoutingService } from './account-routing.service';
import { MemberActionsService } from './member-actions.service';
import { InviteActionsService } from './invite-actions.service';
import { SpaceActionsService } from './space-actions.service';
import { RoomActionsService } from './room-actions.service';
import { ReadStateService } from './read-state.service';
import { MessageActionsService } from './message-actions.service';
import { ShellShortcutsService } from './shell-shortcuts.service';
import { SessionActionsService } from './session-actions.service';
import { ROUTE_PROVIDER } from './rooms-page.spec-harness';

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
/**
 * A host that provides the REAL ShellStatusService and wires the same effect RoomsPage
 * wires, so the dedupe below is a property of the shipped error channel rather than of a
 * signal declared in this file.
 */
@Component({ template: '', providers: [ShellStatusService] })
class ErrorChannelHostComponent {
  readonly status = inject(ShellStatusService);

  constructor() {
    // Mirrors rooms.page.ts: one effect, reading the one error signal.
    effect(() => {
      const message = this.status.error();
      if (message) {
        void this.status.showError(message);
      }
    });
  }

  fail(message: string): void {
    runWithBusy(
      throwError(() => new Error(message)),
      this.status,
    ).subscribe();
  }
}

function buildErrorChannel(): {
  host: ErrorChannelHostComponent;
  toasts: () => string[];
  fixture: ComponentFixture<ErrorChannelHostComponent>;
} {
  const shown: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      MockProvider(TrnToastService, {
        show: (m: string) => void shown.push(m),
      }),
    ],
  });
  const fixture = TestBed.createComponent(ErrorChannelHostComponent);
  fixture.detectChanges();
  shown.length = 0;
  return { host: fixture.componentInstance, toasts: () => shown, fixture };
}

describe('one error channel produces one toast per flush', () => {
  // Why this matters: `spaceBusy`/`spaceError` look like space state but are read across
  // four of the five handler clusters, and a single effect toasts on them. Giving each
  // extracted coordinator its own pair would turn one effect into N. The dedupe below is
  // the property that would silently break.
  it('toasts once for two failures that land in the same flush', () => {
    const { host, toasts, fixture } = buildErrorChannel();

    host.fail('first');
    host.fail('second');
    fixture.detectChanges();

    // A signal read in an effect sees only the latest value per flush, so two failures
    // in one turn surface as one toast carrying the second message.
    expect(toasts()).toEqual(['second']);
  });

  it('toasts twice for two failures in separate flushes', () => {
    const { host, toasts, fixture } = buildErrorChannel();

    host.fail('first');
    fixture.detectChanges();
    host.fail('second');
    fixture.detectChanges();

    expect(toasts()).toEqual(['first', 'second']);
  });

  it('clears the error before each run, so an identical failure toasts again', () => {
    const { host, toasts, fixture } = buildErrorChannel();

    host.fail('same');
    fixture.detectChanges();
    host.fail('same');
    fixture.detectChanges();

    // `runWithBusy` nulls `error` synchronously at call time, so the signal changes
    // value twice and the effect re-runs. Without that reset the second failure would
    // be swallowed as a no-op write.
    expect(toasts()).toEqual(['same', 'same']);
  });
});

/**
 * The thirteen classes that must be page-scoped rather than root-provided. Typed as
 * `Type<unknown>` so the array is a list of tokens rather than a union TestBed.inject
 * cannot resolve to one instance type.
 */
const COORDINATORS: Type<unknown>[] = [
  RoomShellStore,
  ShellStatusService,
  RoomShellViewModel,
  RoomShellNavigationService,
  AccountRoutingService,
  MemberActionsService,
  InviteActionsService,
  SpaceActionsService,
  RoomActionsService,
  ReadStateService,
  MessageActionsService,
  ShellShortcutsService,
  SessionActionsService,
];

describe('the shell coordinators are page-scoped, not root-provided', () => {
  // rooms.page.spec.ts registers all thirteen at the TestBed root so its 170 tests can
  // reach them, which means that suite would stay green if any of them became
  // `providedIn: 'root'` or if RoomsPage lost its `providers:` array — and every
  // runWithBusy subscription in the shell would then outlive the page. These two
  // assertions are what actually hold the design in place.
  it('none of them resolves from a bare injector', () => {
    TestBed.configureTestingModule({});

    for (const coordinator of COORDINATORS) {
      expect(
        TestBed.inject(coordinator, null, { optional: true }),
        `${coordinator.name} must not be providedIn: 'root'`,
      ).toBeNull();
    }
  });

  it('resolves them from the page, not from the environment injector', () => {
    // The other half of the invariant: deleting RoomsPage's `providers:` array. Inspecting
    // the component's `providersResolver` cannot detect that — `viewProviders` (the page's
    // icons) sets it too — but overriding the template to empty PRESERVES `providers:`
    // while dropping every child component, so the page can be constructed cheaply and
    // asked what its own node injector holds. Root-registering the same token as well
    // proves the page is answering, not the environment.
    TestBed.configureTestingModule({
      providers: [RoomShellStore, ROUTE_PROVIDER],
    });
    TestBed.overrideComponent(RoomsPage, {
      set: { template: '', imports: [], host: {} },
    });

    const fixture = TestBed.createComponent(RoomsPage);

    expect(fixture.debugElement.injector.get(RoomShellStore)).not.toBe(
      TestBed.inject(RoomShellStore),
    );
  });
});
