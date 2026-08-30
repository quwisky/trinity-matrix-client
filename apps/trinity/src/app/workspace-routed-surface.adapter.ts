import { Location } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
 * Host-owned adapter for canonical application-surface routes and cold deep links.
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly back = inject(WorkspaceBackService);
  private readonly active = signal<WorkspaceSurface | null>(null);

  constructor() {
    this.update(this.router.url);
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => this.update(event.urlAfterRedirects));
    const unregister = this.back.register({
      surface: this.active,
      dismiss: (surface) => this.dismiss(surface),
    });
    this.destroyRef.onDestroy(unregister);
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

  private update(url: string): void {
    const surface = this.applicationSurface(url);
    this.active.set(surface ? { layer: 'application', surface } : null);
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
