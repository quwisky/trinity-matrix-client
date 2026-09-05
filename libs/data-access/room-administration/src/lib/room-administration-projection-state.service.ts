import { Injectable, inject, signal } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import type {
  RoomAdministrationAvailability,
  RoomAdministrationOperation,
  RoomAdministrationView,
} from './room-administration-health.models';

const unavailable = (): Record<
  RoomAdministrationOperation,
  RoomAdministrationAvailability
> => ({
  permissions: 'unavailable',
  members: 'unavailable',
  bans: 'unavailable',
});

/** Internal exact-scope freshness ledger shared by Room Administration readers. */
@Injectable({ providedIn: 'root' })
export class RoomAdministrationProjectionState {
  private readonly matrix = inject(MatrixClientService);
  private scope: {
    readonly accountId: string;
    readonly roomId: string;
  } | null = null;
  private readonly coherent = new Set<RoomAdministrationOperation>();
  private readonly state = signal(unavailable());

  select(accountId: string | null, roomId: string | null): void {
    this.scope = accountId && roomId ? { accountId, roomId } : null;
    this.coherent.clear();
    this.state.set(unavailable());
  }

  update(
    operation: RoomAdministrationOperation,
    condition: 'available' | 'reconciling' | 'failed' | 'released',
    ownership: 'retained' | 'released',
  ): void {
    let availability: RoomAdministrationAvailability = 'unavailable';
    if (this.scope && condition === 'available' && ownership === 'retained') {
      this.coherent.add(operation);
      availability = 'coherent';
    } else if (
      this.scope &&
      ownership === 'retained' &&
      this.coherent.has(operation)
    ) {
      availability = 'stale';
    }
    if (ownership === 'released') this.coherent.delete(operation);
    this.state.update((current) => ({ ...current, [operation]: availability }));
  }

  availability(
    operation: RoomAdministrationOperation,
    roomId: string | null,
  ): RoomAdministrationAvailability {
    const scope = this.scope;
    return scope &&
      roomId === scope.roomId &&
      this.matrix.activeUserId() === scope.accountId
      ? this.state()[operation]
      : 'unavailable';
  }

  view<T>(
    operation: RoomAdministrationOperation,
    roomId: string | null,
    value: T,
  ): RoomAdministrationView<T> {
    switch (this.availability(operation, roomId)) {
      case 'coherent':
        return { availability: 'coherent', current: value, stale: null };
      case 'stale':
        return { availability: 'stale', current: null, stale: value };
      default:
        return { availability: 'unavailable', current: null, stale: null };
    }
  }

  release(): void {
    this.scope = null;
    this.coherent.clear();
    this.state.set(unavailable());
  }
}
