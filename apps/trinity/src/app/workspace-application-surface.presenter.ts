import {
  DestroyRef,
  Injectable,
  inject,
  signal,
  type Type,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStart, Router } from '@angular/router';
import {
  WorkspaceBackService,
  sameWorkspaceApplicationSurface,
  type WorkspaceApplicationSurface,
  type WorkspaceApplicationSurfaceOutcome,
  type WorkspaceApplicationSurfacePresenter,
  type WorkspaceApplicationSurfaceRequest,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  type EncryptionDialogKind,
} from '@trinity/components/encryption-dialog';
import {
  TrnDialogRef,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MD_QUERY, matchesQuery } from '@trinity/util/ui';
import {
  Observable,
  catchError,
  defer,
  filter,
  finalize,
  from,
  map,
  of,
  shareReplay,
  switchMap,
  take,
} from 'rxjs';
import { SETTINGS_DIALOG_APP_CONFIG } from './settings-dialog.config';

interface ActiveApplicationDialog {
  readonly surface: WorkspaceApplicationSurface;
  readonly ref: TrnDialogRef<unknown>;
  readonly dismissible: boolean;
}

function routeFor(surface: WorkspaceApplicationSurface): string {
  if (surface.kind === 'settings') {
    return surface.section ? `/settings/${surface.section}` : '/settings';
  }
  return `/encryption/${surface.flow}`;
}

/** Host adapter combining Router, placement policy, lazy features, and UI dialogs. */
@Injectable({ providedIn: 'root' })
export class WorkspaceApplicationSurfacePresenterAdapter implements WorkspaceApplicationSurfacePresenter {
  private readonly router = inject(Router);
  private readonly dialog = inject(TrnDialogService);
  private readonly toast = inject(TrnToastService);
  private readonly back = inject(WorkspaceBackService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly encryptionLoaders = inject(ENCRYPTION_DIALOG_COMPONENTS, {
    optional: true,
  });
  private readonly active = signal<readonly ActiveApplicationDialog[]>([]);
  private pending: {
    readonly surface: WorkspaceApplicationSurface;
    readonly command: Observable<WorkspaceApplicationSurfaceOutcome>;
  } | null = null;
  private navigationGeneration = 0;

  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationStart),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.navigationGeneration++);
    const unregister = this.back.register({
      surface: () => {
        const active = this.active().at(-1);
        return active
          ? ({ layer: 'application', surface: active.surface } as const)
          : null;
      },
      dismiss: (surface) => this.dismiss(surface),
      ownsTopmostOverlay: () => {
        const active = this.active().at(-1);
        return active ? this.dialog.isTopmost(active.ref) : false;
      },
    });
    this.destroyRef.onDestroy(unregister);
  }

  present(
    request: WorkspaceApplicationSurfaceRequest,
  ): Observable<WorkspaceApplicationSurfaceOutcome> {
    return defer(() => this.presentNow(request));
  }

  private presentNow(
    request: WorkspaceApplicationSurfaceRequest,
  ): Observable<WorkspaceApplicationSurfaceOutcome> {
    const { surface, context } = request;
    if (!this.ownerIsActive(request) || !this.canPresentOverActive(request)) {
      return of({ kind: 'unavailable', surface });
    }
    if (surface.kind === 'settings') {
      if (!SETTINGS_DIALOG_APP_CONFIG.shouldPresentAsDialog()) {
        return this.navigate(request);
      }
      return this.presentDialog(
        request,
        SETTINGS_DIALOG_APP_CONFIG.load,
        true,
        {
          inputs: {
            ...(surface.section ? { initialSection: surface.section } : {}),
            ...(context?.sourceRoomId
              ? { initialSource: context.sourceRoomId }
              : {}),
          },
          ariaLabel: 'Settings',
          autoFocus: '[data-settings-autofocus]',
        },
      );
    }
    if (surface.flow === 'setup') return this.navigate(request);
    const load = this.encryptionLoader(surface.flow);
    if (load && (context?.placement === 'nested' || matchesQuery(MD_QUERY))) {
      return this.presentDialog(request, load, false, {
        inputs: {
          asModal: true,
          ...(context?.offerReset ? { offerReset: true } : {}),
        },
        disableClose: true,
        ariaLabel: 'Encryption',
      });
    }
    if (context?.placement === 'nested') {
      this.showOpenFailure(surface);
      return of({ kind: 'unavailable', surface });
    }
    return this.navigate(request);
  }

  private presentDialog(
    request: WorkspaceApplicationSurfaceRequest,
    load: () => Promise<Type<unknown>>,
    dismissible: boolean,
    options: Parameters<TrnDialogService['open']>[1],
  ): Observable<WorkspaceApplicationSurfaceOutcome> {
    if (this.pending) {
      return sameWorkspaceApplicationSurface(
        this.pending.surface,
        request.surface,
      )
        ? this.pending.command
        : of({ kind: 'unavailable', surface: request.surface });
    }
    const navigationGeneration = this.navigationGeneration;
    const task = from(load()).pipe(
      switchMap((component) =>
        defer(() => {
          if (
            navigationGeneration !== this.navigationGeneration ||
            !this.ownerIsActive(request) ||
            !this.canPresentOverActive(request)
          ) {
            return of({
              kind: 'unavailable',
              surface: request.surface,
            } as const);
          }
          const ref = this.dialog.open(component, {
            ...options,
          });
          this.active.update((active) => [
            ...active,
            { surface: request.surface, ref, dismissible },
          ]);
          ref.closed
            .pipe(
              take(1),
              finalize(() => {
                this.active.update((active) =>
                  active.filter((dialog) => dialog.ref !== ref),
                );
                this.restoreOwner(request, navigationGeneration);
              }),
            )
            .subscribe();
          return of({ kind: 'presented', surface: request.surface } as const);
        }),
      ),
      catchError(() => {
        if (
          navigationGeneration === this.navigationGeneration &&
          this.ownerIsActive(request)
        ) {
          this.showOpenFailure(request.surface);
          this.restoreOwner(request, navigationGeneration);
        }
        return of({ kind: 'unavailable', surface: request.surface } as const);
      }),
      finalize(() => {
        if (this.pending?.command === task) this.pending = null;
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.pending = { surface: request.surface, command: task };
    return task;
  }

  private navigate(
    request: WorkspaceApplicationSurfaceRequest,
  ): Observable<WorkspaceApplicationSurfaceOutcome> {
    const returnTo = request.context?.returnTo;
    const queryParams = {
      ...(returnTo ? { returnTo: routeFor(returnTo) } : {}),
      ...(request.surface.kind === 'trust' &&
      request.surface.flow === 'unlock' &&
      request.context?.offerReset
        ? { reset: '1' }
        : {}),
    };
    return from(
      this.router.navigate([routeFor(request.surface)], {
        ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
      }),
    ).pipe(
      map((accepted) => ({
        kind: accepted ? ('presented' as const) : ('unavailable' as const),
        surface: request.surface,
      })),
    );
  }

  private dismiss(
    surface: WorkspaceSurface,
  ): Observable<'dismissed' | 'blocked'> {
    return defer(() => {
      const active = this.active().at(-1);
      if (
        surface.layer !== 'application' ||
        !active ||
        !sameWorkspaceApplicationSurface(active.surface, surface.surface) ||
        !active.dismissible
      ) {
        return of('blocked' as const);
      }
      active.ref.close();
      return of('dismissed' as const);
    });
  }

  private canPresentOverActive(
    request: WorkspaceApplicationSurfaceRequest,
  ): boolean {
    const active = this.active();
    if (active.length === 0) return true;
    const owner = active.at(-1)?.surface;
    return (
      active.length === 1 &&
      owner?.kind === 'settings' &&
      request.surface.kind === 'trust' &&
      request.context?.placement === 'nested'
    );
  }

  private encryptionLoader(
    flow: EncryptionDialogKind,
  ): (() => Promise<Type<unknown>>) | undefined {
    return this.encryptionLoaders?.[flow];
  }

  private ownerIsActive(request: WorkspaceApplicationSurfaceRequest): boolean {
    try {
      return request.context?.ownerActive?.() ?? true;
    } catch {
      return false;
    }
  }

  private restoreOwner(
    request: WorkspaceApplicationSurfaceRequest,
    navigationGeneration: number,
  ): void {
    if (
      request.context?.restoreFocus &&
      navigationGeneration === this.navigationGeneration
    ) {
      queueMicrotask(request.context.restoreFocus);
    }
  }

  private showOpenFailure(surface: WorkspaceApplicationSurface): void {
    const name = surface.kind === 'settings' ? 'Settings' : 'Encryption';
    this.toast.show(`Could not open ${name}. Please try again.`, {
      duration: 5000,
      variant: 'destructive',
    });
  }
}
