import { Injectable, signal, type WritableSignal } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';

export interface ImagePackSelectionSnapshot {
  readonly present: boolean;
  readonly content: unknown;
}

export const OPTIMISTIC_TTL_MS = 30_000;

interface StoredSelection {
  readonly snapshot: ImagePackSelectionSnapshot;
  readonly expiresAt: number;
}

/** Shares the newest confirmed MSC2545 account data between management and picker projections. */
@Injectable({ providedIn: 'root' })
export class ImagePackSelectionStore {
  // One signal per client, created on first access, so a reader re-runs only for its own
  // client's selection (the per-entity pattern of #121/#126; there is no shared revision).
  private readonly selections = new WeakMap<
    MatrixClient,
    WritableSignal<StoredSelection | null>
  >();

  private selection(
    client: MatrixClient,
  ): WritableSignal<StoredSelection | null> {
    let selection = this.selections.get(client);
    if (!selection) {
      selection = signal<StoredSelection | null>(null);
      this.selections.set(client, selection);
    }
    return selection;
  }

  get(client: MatrixClient): ImagePackSelectionSnapshot | null {
    const stored = this.selection(client)();
    return stored && stored.expiresAt > Date.now() ? stored.snapshot : null;
  }

  set(client: MatrixClient, snapshot: ImagePackSelectionSnapshot): void {
    this.selection(client).set({
      snapshot,
      expiresAt: Date.now() + OPTIMISTIC_TTL_MS,
    });
  }

  /** The SDK cache is authoritative once its account-data echo arrives. */
  clear(client: MatrixClient): void {
    this.selections.get(client)?.set(null);
  }
}
