import { Injectable, signal } from '@angular/core';

/**
 * Whether the app is doing work that must go on in a phone's background, such as a running
 * call. Set by the owner of that work; read by the lifecycle code that would otherwise
 * suspend sync, so the startup code never imports the owner.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundActivityService {
  private readonly activeState = signal(false);

  readonly active = this.activeState.asReadonly();

  set(active: boolean): void {
    this.activeState.set(active);
  }
}
