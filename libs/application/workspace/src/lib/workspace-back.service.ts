import { Injectable, computed, signal } from '@angular/core';
import { Observable, defaultIfEmpty, defer, map, of, take } from 'rxjs';
import type {
  WorkspaceBackOutcome,
  WorkspaceDismissResult,
  WorkspaceSurface,
} from './workspace-surface.models';

/** A presentation adapter offering its current semantic surface to Workspace. */
export interface WorkspaceBackRegistration {
  /** Null while this adapter has no semantic surface to dismiss. */
  readonly surface: () => WorkspaceSurface | null;
  /** Cold, finite dismissal of the exact surface captured by Workspace. */
  readonly dismiss: (
    surface: WorkspaceSurface,
  ) => Observable<WorkspaceDismissResult>;
  /** Whether this semantic adapter owns the UI overlay currently at the top. */
  readonly ownsTopmostOverlay?: () => boolean;
}

interface ActiveRegistration {
  readonly registration: WorkspaceBackRegistration;
  readonly surface: WorkspaceSurface;
}

const BACK_ORDER: readonly WorkspaceSurface['layer'][] = [
  'application',
  'room',
  'conversation',
];

/**
 * The semantic Back policy shared by browser, Capacitor, and presentation adapters.
 *
 * UI-local overlays are handled by the host before this service. Workspace then applies a
 * stable layer order independent of registration timing: application surface, Room surface,
 * compact Conversation. Browser history and host-root behavior remain host fallthroughs.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceBackService {
  private readonly registrations = signal<readonly WorkspaceBackRegistration[]>(
    [],
  );

  /** The exact semantic surface that owns the next Back intent, if any. */
  readonly activeSurface = computed(
    () => this.findActiveRegistration()?.surface ?? null,
  );

  readonly hasActive = computed(() => this.activeSurface() !== null);

  /** Live host query used to let UI-local overlays outrank semantic surfaces. */
  activeOwnsTopmostOverlay(): boolean {
    return (
      this.findActiveRegistration()?.registration.ownsTopmostOverlay?.() ??
      false
    );
  }

  /** Register one lazy presentation adapter; returns its idempotent removal. */
  register(registration: WorkspaceBackRegistration): () => void {
    this.registrations.update((current) => [...current, registration]);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.registrations.update((current) => {
        const at = current.lastIndexOf(registration);
        return at < 0
          ? current
          : [...current.slice(0, at), ...current.slice(at + 1)];
      });
    };
  }

  /**
   * Dismiss the highest-priority semantic surface as one cold, finite command.
   *
   * The surface is captured on subscription, not command creation. This lets a native Back
   * event create the command synchronously while preserving the state that actually owns the
   * press when the application shell subscribes.
   */
  back(): Observable<WorkspaceBackOutcome> {
    return defer(() => {
      const active = this.findActiveRegistration();
      if (!active) return of({ kind: 'unhandled' } as const);
      return active.registration.dismiss(active.surface).pipe(
        take(1),
        defaultIfEmpty('blocked' as const),
        map((kind): WorkspaceBackOutcome => ({
          kind,
          surface: active.surface,
        })),
      );
    });
  }

  private findActiveRegistration(): ActiveRegistration | null {
    const registrations = [...this.registrations()].reverse();
    for (const layer of BACK_ORDER) {
      for (const registration of registrations) {
        const surface = registration.surface();
        if (surface?.layer === layer) return { registration, surface };
      }
    }
    return null;
  }
}
