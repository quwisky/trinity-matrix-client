import { Injectable, signal, type WritableSignal } from '@angular/core';

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
  // One signal per account, created on first access, so a reader re-runs only for its own
  // account's selection.
  private readonly selections = new Map<
    string,
    WritableSignal<StoredSelection | null>
  >();

  private selection(accountId: string): WritableSignal<StoredSelection | null> {
    let selection = this.selections.get(accountId);
    if (!selection) {
      selection = signal<StoredSelection | null>(null);
      this.selections.set(accountId, selection);
    }
    return selection;
  }

  get(accountId: string): ImagePackSelectionSnapshot | null {
    const stored = this.selection(accountId)();
    return stored && stored.expiresAt > Date.now() ? stored.snapshot : null;
  }

  set(accountId: string, snapshot: ImagePackSelectionSnapshot): void {
    this.selection(accountId).set({
      snapshot,
      expiresAt: Date.now() + OPTIMISTIC_TTL_MS,
    });
  }

  /** The synced copy is authoritative once its account-data echo arrives. */
  clear(accountId: string): void {
    this.selections.get(accountId)?.set(null);
  }
}
