import { Injectable, computed, signal } from '@angular/core';

/** The areas a page offers the active call; without a stage it shows docked. */
@Injectable({ providedIn: 'root' })
export class CallStageService {
  private readonly stage = signal<HTMLElement | null>(null);
  private readonly dock = signal<HTMLElement | null>(null);
  private readonly dockClaims = signal<symbol | null>(null);

  readonly element = this.stage.asReadonly();
  readonly dockElement = this.dock.asReadonly();
  /** Whether a host element currently stands ready to show the docked card. */
  readonly dockPresent = computed(() => this.dockClaims() !== null);

  /** Returns a release that leaves a newer registration in place. */
  register(element: HTMLElement): () => void {
    this.stage.set(element);
    return () => {
      if (this.stage() === element) this.stage.set(null);
    };
  }

  /** Same release rule as `register`, for the sidebar slot that holds the docked card. */
  registerDock(element: HTMLElement): () => void {
    this.dock.set(element);
    return () => {
      if (this.dock() === element) this.dock.set(null);
    };
  }

  /** Returns a release that leaves a newer claim in place. */
  claimDock(): () => void {
    const claim = Symbol('dock');
    this.dockClaims.set(claim);
    return () => {
      if (this.dockClaims() === claim) this.dockClaims.set(null);
    };
  }
}
