import { Injectable, signal } from '@angular/core';

/** The area a page offers the active call; without one the call shows docked. */
@Injectable({ providedIn: 'root' })
export class CallStageService {
  private readonly stage = signal<HTMLElement | null>(null);

  readonly element = this.stage.asReadonly();

  /** Returns a release that leaves a newer registration in place. */
  register(element: HTMLElement): () => void {
    this.stage.set(element);
    return () => {
      if (this.stage() === element) this.stage.set(null);
    };
  }
}
