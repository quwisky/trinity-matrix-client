import { Location } from '@angular/common';
import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { AppLockService } from '@trinity/data-access/app-lock';
import {
  InboundRoomLinkService,
  WorkspaceBackService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { parseTrinityRoomLink } from '@trinity/util/matrix';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { NativeNavigationService } from '@trinity/platform-native';
import {
  HostBackService,
  HostDeepLinksService,
  type HostCapabilitySupport,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import {
  EMPTY,
  NEVER,
  Observable,
  catchError,
  concatMap,
  defer,
  from,
  ignoreElements,
  map,
  merge,
  of,
  repeat,
  retry,
  share,
  switchMap,
  take,
  tap,
  throwError,
  throwIfEmpty,
  timer,
  timeout,
} from 'rxjs';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';
import { HostSessionHealthService } from './host-session-health.service';
import { appLockCovers } from './app-lock.providers';

/** Owns the host navigation intents (deep links, Back, history gestures) and their incidents. */
@Injectable({ providedIn: 'root' })
export class TrinityHostNavigationAdapter {
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly toast = inject(TrnToastService);
  private readonly dialog = inject(TrnSurfaceService);
  private readonly workspaceBack = inject(WorkspaceBackService);
  private readonly workspaceNavigation = inject(WorkspaceNavigationService);
  private readonly nativeNavigation = inject(NativeNavigationService);
  private readonly hostDeepLinks = inject(HostDeepLinksService);
  private readonly hostBack = inject(HostBackService);
  private readonly appLock = inject(AppLockService);
  private readonly hostHealth = inject(HostSessionHealthService);
  private readonly routedSurfaces = inject(WorkspaceRoutedSurfaceAdapter);
  private readonly inboundRoomLink = inject(InboundRoomLinkService);
  private readonly interactions = defer(() =>
    merge(
      this.runBackIntents().pipe(ignoreElements()),
      this.runNavigationGesturePolicy().pipe(ignoreElements()),
    ),
  ).pipe(share());

  /** One shared Back/gesture owner, subscribed by the root before readiness. */
  runInteractions(): Observable<never> {
    return this.interactions;
  }

  runDeepLinks(): Observable<void> {
    return this.runSupportedHostStream(
      'deep-links',
      'deep-link-support-check-failed',
      () => this.hostDeepLinks.support(),
      () =>
        this.hostDeepLinks.received.pipe(
          tap({
            error: () =>
              this.reportHostIncident(
                'deep-links',
                'deep-link-listener-failed',
              ),
            complete: () =>
              this.reportHostIncident(
                'deep-links',
                'deep-link-listener-ownership-released',
              ),
          }),
          retry({ delay: 1_000 }),
          repeat({ delay: 1_000 }),
          concatMap(({ url }) => this.handleDeepLink(url)),
        ),
    );
  }

  private handleDeepLink(url: string): Observable<void> {
    const roomLink = parseTrinityRoomLink(url);
    if (roomLink) {
      // The Rooms shell opens it exactly like a tapped matrix.to link, once it exists.
      this.inboundRoomLink.offer(roomLink);
      return EMPTY;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return EMPTY;
    }
    if (parsed.protocol !== APP_URL_PROTOCOL) return EMPTY;
    const path = parsed.host || parsed.pathname.replace(/^\/+/, '');
    const params = parsed.searchParams;
    if (
      path !== 'sso-callback' ||
      (!params.has('loginToken') && !params.has('code') && !params.has('error'))
    ) {
      return EMPTY;
    }
    const queryParams: Record<string, string> = {};
    for (const key of CALLBACK_PARAMS) {
      const value = params.get(key);
      if (value !== null) queryParams[key] = value;
    }
    return this.hostDeepLinks.closeAuthentication().pipe(
      tap((outcome) => {
        if (hostOutcomeFailed(outcome))
          this.reportHostIncident(
            'authentication-handoff',
            'authentication-close-failed',
          );
      }),
      switchMap(() =>
        from(this.router.navigate(['/sso-callback'], { queryParams })),
      ),
      switchMap((navigated) =>
        navigated
          ? of(void 0)
          : this.hostIncident('deep-links', 'deep-link-navigation-rejected'),
      ),
      catchError(() =>
        this.hostIncident('deep-links', 'deep-link-navigation-failed'),
      ),
    );
  }

  private runBackIntents(): Observable<void> {
    return this.runSupportedHostStream(
      'back',
      'host-back-support-check-failed',
      () => this.hostBack.support(),
      () =>
        this.hostBack.intents.pipe(
          tap({
            error: () =>
              this.reportHostIncident('back', 'host-back-listener-failed'),
            complete: () =>
              this.reportHostIncident(
                'back',
                'host-back-listener-ownership-released',
              ),
          }),
          retry({ delay: 1_000 }),
          repeat({ delay: 1_000 }),
          concatMap(({ canGoBack }) =>
            defer(() => {
              // Android Back reaches here past the lock screen's inert dialog. While App
              // lock covers the app it never acts on what is behind the cover: it sends
              // the app to the background, like the system lock screen does.
              if (appLockCovers(untracked(this.appLock.status))) {
                return this.backgroundApp();
              }
              if (
                this.dialog.hasOpen() &&
                !this.workspaceBack.activeOwnsTopmostOverlay()
              ) {
                this.dialog.closeTopmost();
                return of(void 0);
              }
              if (this.workspaceBack.hasActive()) {
                return this.workspaceBack.back().pipe(
                  take(1),
                  map(() => void 0),
                  catchError(() =>
                    this.hostIncident('back', 'workspace-back-failed'),
                  ),
                );
              }
              if (this.dialog.hasOpen()) {
                this.dialog.closeTopmost();
                return of(void 0);
              }
              if (canGoBack) {
                this.location.back();
                return of(void 0);
              }
              return this.backgroundApp();
            }),
          ),
        ),
    );
  }

  /** A host that can't background the app drops the intent; a failure is an incident. */
  private backgroundApp(): Observable<void> {
    return this.hostBack.background().pipe(
      take(1),
      switchMap((outcome) =>
        hostOutcomeFailed(outcome)
          ? this.hostIncident('back', 'host-background-failed')
          : of(void 0),
      ),
    );
  }

  private runSupportedHostStream(
    operation: 'deep-links' | 'back',
    failureCode: string,
    support: () => Observable<HostCapabilitySupport>,
    stream: () => Observable<void>,
  ): Observable<void> {
    let incidentReported = false;
    return defer(support).pipe(
      take(1),
      throwIfEmpty(() => new Error('Host support returned no outcome.')),
      timeout(10_000),
      switchMap((outcome) => {
        if (outcome.kind === 'supported') {
          incidentReported = false;
          return stream();
        }
        return outcome.reason === 'not-supported' ||
          outcome.reason === 'not-implemented'
          ? NEVER
          : throwError(() => new Error('Host support negotiation failed.'));
      }),
      retry({
        delay: () => {
          if (!incidentReported) {
            incidentReported = true;
            this.reportHostIncident(operation, failureCode);
          }
          return timer(1_000);
        },
      }),
    );
  }

  private hostIncident(operation: string, code: string): Observable<never> {
    this.reportHostIncident(operation, code);
    return EMPTY;
  }

  private reportHostIncident(operation: string, code: string): void {
    this.hostHealth.incident('host', operation, code);
    this.toast.show('A host navigation action could not be completed.', {
      duration: 4000,
      variant: 'danger',
    });
  }

  private runNavigationGesturePolicy(): Observable<void> {
    return new Observable(() => {
      const policy = effect(
        () => {
          // A routed surface, or a Conversation pushed over its list, is browser history,
          // as in workspaceBrowserBackGuard, so the history swipe may navigate it; dialogs
          // and panels must consume Back.
          const active = this.workspaceBack.activeSurface();
          const historyBack =
            active === null ||
            this.routedSurfaces.owns(active) ||
            (active.layer === 'conversation' &&
              this.workspaceNavigation.conversationOverList());
          const interceptionActive = this.dialog.openState() || !historyBack;
          this.nativeNavigation.setHistoryGesturesEnabled(!interceptionActive);
        },
        { injector: this.injector },
      );
      return () => policy.destroy();
    });
  }
}

/** The only scheme the app registers; a callback on any other scheme is not ours. */
const APP_URL_PROTOCOL = 'dev.trinityproject.trinity:';

const CALLBACK_PARAMS = [
  'loginToken',
  'sso_state',
  'code',
  'state',
  'error',
  'error_description',
  // RFC 9207: lets the callback check the response comes from the provider it started with.
  'iss',
] as const;

function hostOutcomeFailed(outcome: HostOperationOutcome): boolean {
  return (
    outcome.kind === 'rejected' ||
    (outcome.kind === 'unavailable' &&
      outcome.reason !== 'not-supported' &&
      outcome.reason !== 'not-implemented')
  );
}
