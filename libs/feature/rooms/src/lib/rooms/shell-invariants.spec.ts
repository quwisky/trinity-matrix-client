import {
  Component,
  DestroyRef,
  Injectable,
  inject,
  signal,
  type Type,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { RoomsPage } from './rooms.page';
import { runWithBusy } from '@trinity/util/ui';
import { throwError } from 'rxjs';
import { MockProvider } from 'ng-mocks';
import { TrnToastService } from '@trinity/components/overlay';
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
import { WorkspaceService } from './workspace.service';
import { WorkspaceTransitionWorkflow } from './workspace-transition.workflow';
import { ROUTE_PROVIDER } from './rooms-page.spec-harness';

/**
 * The two framework behaviours the #62 decomposition rests on, pinned before anything
 * moves.
 *
 * Neither is covered by `rooms.page.spec.ts`: that spec builds the page with
 * `TestBed.inject(RoomsPage)` and never renders it. Both suites below render a real
 * component so page-scoped lifetimes and presentation behaviour match the shipped app.
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
 * `runWithBusy`, with presentation owned by the same page-scoped service.
 */
/**
 * A host that provides the REAL ShellStatusService, so the dedupe below is a property of
 * the shipped error channel rather than of a signal declared in this file.
 */
@Component({ template: '', providers: [ShellStatusService] })
class ErrorChannelHostComponent {
  readonly status = inject(ShellStatusService);

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

describe('one error channel produces one toast per turn', () => {
  // Why this matters: `spaceBusy`/`spaceError` look like space state but are read across
  // four of the five handler clusters. Giving each extracted coordinator its own pair
  // would turn one presentation channel into N. The dedupe below is the property that
  // would silently break.
  it('toasts once for two failures that land in the same turn', async () => {
    const { host, toasts } = buildErrorChannel();

    host.fail('first');
    host.fail('second');
    await Promise.resolve();

    // Presentation reads the latest signal value once its queued microtask runs.
    expect(toasts()).toEqual(['second']);
  });

  it('toasts twice for two failures in separate turns', async () => {
    const { host, toasts } = buildErrorChannel();

    host.fail('first');
    await Promise.resolve();
    host.fail('second');
    await Promise.resolve();

    expect(toasts()).toEqual(['first', 'second']);
  });

  it('clears the error before each run, so an identical failure toasts again', async () => {
    const { host, toasts } = buildErrorChannel();

    host.fail('same');
    await Promise.resolve();
    host.fail('same');
    await Promise.resolve();

    // `runWithBusy` nulls `error` synchronously at call time before capturing it again.
    expect(toasts()).toEqual(['same', 'same']);
  });

  it('suppresses a queued toast after the page-scoped channel is destroyed', async () => {
    const { host, toasts, fixture } = buildErrorChannel();

    host.fail('too late');
    fixture.destroy();
    await Promise.resolve();

    expect(toasts()).toEqual([]);
  });
});

/**
 * The fifteen classes that must be page-scoped rather than root-provided. Typed as
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
  WorkspaceTransitionWorkflow,
  WorkspaceService,
];

describe('the shell coordinators are page-scoped, not root-provided', () => {
  // The split rooms-page specs register all fifteen at the TestBed root so they can
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
      providers: [{ provide: RoomShellStore, useValue: {} }, ROUTE_PROVIDER],
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
