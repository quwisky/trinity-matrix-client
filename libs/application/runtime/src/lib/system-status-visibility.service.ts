import { Injectable, signal } from '@angular/core';

/** Whether System status is open; the application root presents the surface that follows it. */
@Injectable({ providedIn: 'root' })
export class SystemStatusVisibilityService {
  private readonly opened = signal(false);

  readonly open = this.opened.asReadonly();

  show(): void {
    this.opened.set(true);
  }

  close(): void {
    this.opened.set(false);
  }
}
