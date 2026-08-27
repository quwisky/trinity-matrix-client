import { Injectable, signal } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';

export interface ImagePackSelectionSnapshot {
  readonly present: boolean;
  readonly content: unknown;
}

const OPTIMISTIC_TTL_MS = 30_000;

interface StoredSelection {
  readonly snapshot: ImagePackSelectionSnapshot;
  readonly expiresAt: number;
}

/** Shares the newest confirmed MSC2545 account data between management and picker projections. */
@Injectable({ providedIn: 'root' })
export class ImagePackSelectionStore {
  private readonly snapshots = new WeakMap<MatrixClient, StoredSelection>();
  private readonly revision = signal(0);

  readonly changed = this.revision.asReadonly();

  get(client: MatrixClient): ImagePackSelectionSnapshot | null {
    this.revision();
    const stored = this.snapshots.get(client);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      this.snapshots.delete(client);
      return null;
    }
    return stored.snapshot;
  }

  set(client: MatrixClient, snapshot: ImagePackSelectionSnapshot): void {
    this.snapshots.set(client, {
      snapshot,
      expiresAt: Date.now() + OPTIMISTIC_TTL_MS,
    });
    this.revision.update((value) => value + 1);
  }

  /** The SDK cache is authoritative once its account-data echo arrives. */
  clear(client: MatrixClient): void {
    if (!this.snapshots.delete(client)) return;
    this.revision.update((value) => value + 1);
  }
}
