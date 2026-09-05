import { Location } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import {
  WorkspaceBackService,
  sameWorkspaceApplicationSurface,
  type WorkspaceApplicationSurface,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import {
  MD_QUERY,
  matchesQuery,
  resolveInternalReturnTo,
} from '@trinity/util/ui';
import { Observable, defer, filter, from, map, of } from 'rxjs';

/**
 * Application-owned adapter for canonical application-surface routes and cold deep links.
 *
 * It deliberately lives in the composition root: parsing Router URLs and choosing the
 * wide/narrow Settings placement are host policy, not dependencies of Workspace or a
 * product capability. Browser Back keeps using browser history; host Back offers the same
 * semantic surface to Workspace and has a deterministic `/rooms` fallback for a cold link.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceRoutedSurfaceAdapter {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly back = inject(WorkspaceBackService);
  private readonly active = signal<WorkspaceSurface | null>(null);
  private readonly _roomProjectionDemand = signal(false);
  /** Whether the routed Workspace can currently present Room-scoped projections. */
  readonly roomProjectionDemand = this._roomProjectionDemand.asReadonly();
  private currentUrl: string | null = null;
  private previousUrl: string | null = null;

  /** Application Runtime owns route projection and Back registration for one session. */
  run(): Observable<void> {
    return new Observable((subscriber) => {
      this.currentUrl = this.router.url;
      this.update(this.router.url);
      const routes = this.router.events
        .pipe(filter((event) => event instanceof NavigationEnd))
        .subscribe({
          next: (event) => {
            this.previousUrl = this.currentUrl;
            this.currentUrl = event.urlAfterRedirects;
            this.update(event.urlAfterRedirects);
            subscriber.next();
          },
          error: (error: unknown) => subscriber.error(error),
        });
      const unregister = this.back.register({
        surface: this.active,
        dismiss: (surface) => this.dismiss(surface),
      });
      return () => {
        routes.unsubscribe();
        unregister();
        this.active.set(null);
        this._roomProjectionDemand.set(false);
        this.currentUrl = null;
        this.previousUrl = null;
      };
    });
  }

  private dismiss(
    surface: WorkspaceSurface,
  ): Observable<'dismissed' | 'blocked'> {
    return defer(() => {
      if (surface.layer !== 'application' || !this.sameActiveSurface(surface)) {
        return of('blocked' as const);
      }
      const application = surface.surface;
      if (
        application.kind === 'settings' &&
        application.section !== null &&
        !matchesQuery(MD_QUERY)
      ) {
        if (this.settingsSection(this.previousUrl) === null) {
          this.location.back();
          return of('dismissed' as const);
        }
        return this.navigate('/settings');
      }
      if (application.kind === 'trust') {
        const tree = this.router.parseUrl(this.router.url);
        const returnTo = resolveInternalReturnTo(
          tree.queryParams['returnTo'],
          '',
        );
        if (returnTo) return this.navigate(returnTo);
      }
      // A user-opened Settings route normally has browser history; use it so focus and
      // the exact Room URL are restored. A cold deep link has navigationId 1 and needs a
      // deterministic application root instead of minimizing the native host.
      const navigationId = window.history.state?.navigationId;
      if (typeof navigationId === 'number' && navigationId > 1) {
        this.location.back();
        return of('dismissed' as const);
      }
      return this.navigate('/rooms');
    });
  }

  private navigate(url: string): Observable<'dismissed' | 'blocked'> {
    return from(this.router.navigateByUrl(url, { replaceUrl: true })).pipe(
      map((accepted) => (accepted ? 'dismissed' : 'blocked')),
    );
  }

  private sameActiveSurface(surface: WorkspaceSurface): boolean {
    const active = this.active();
    if (!active || active.layer !== surface.layer) return false;
    if (active.layer !== 'application' || surface.layer !== 'application') {
      return false;
    }
    return sameWorkspaceApplicationSurface(active.surface, surface.surface);
  }

  private settingsSection(url: string | null): string | null | undefined {
    if (!url) return undefined;
    const segments = this.router
      .parseUrl(url)
      .root.children['primary']?.segments.map((segment) => segment.path);
    return segments?.[0] === 'settings' ? (segments[1] ?? null) : undefined;
  }

  private update(url: string): void {
    this._roomProjectionDemand.set(this.isRoomRoute(url));
    const surface = this.applicationSurface(url);
    this.active.set(surface ? { layer: 'application', surface } : null);
  }

  private isRoomRoute(url: string): boolean {
    const segments = this.router
      .parseUrl(url)
      .root.children['primary']?.segments.map((segment) => segment.path);
    return segments?.[0] === 'rooms';
  }

  private applicationSurface(url: string): WorkspaceApplicationSurface | null {
    const tree = this.router.parseUrl(url);
    const segments = tree.root.children['primary']?.segments.map(
      (segment) => segment.path,
    );
    if (!segments?.length) return null;
    if (segments[0] === 'settings') {
      return { kind: 'settings', section: segments[1] ?? null };
    }
    if (segments[0] !== 'encryption') return null;
    const flow = segments[1];
    return flow === 'setup' || flow === 'unlock' || flow === 'verify'
      ? { kind: 'trust', flow }
      : null;
  }
}
