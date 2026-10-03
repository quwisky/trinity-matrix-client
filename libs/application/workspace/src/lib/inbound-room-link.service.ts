import { Injectable, signal } from '@angular/core';
import type { MatrixLinkTarget } from '@trinity/util/matrix';

/** A validated room link from the host, waiting for the Rooms shell to open it. */
export type InboundRoomLink = Extract<MatrixLinkTarget, { kind: 'room' }>;

/**
 * One-slot mailbox between the host deep-link stream and the Rooms shell. The shell
 * mounts only for a signed-in account, so a link that arrives earlier (cold start, or
 * signed out) simply waits here; the newest link replaces an unopened older one.
 */
@Injectable({ providedIn: 'root' })
export class InboundRoomLinkService {
  private readonly slot = signal<InboundRoomLink | null>(null);

  readonly pending = this.slot.asReadonly();

  offer(link: InboundRoomLink): void {
    this.slot.set(link);
  }

  clear(): void {
    this.slot.set(null);
  }
}
