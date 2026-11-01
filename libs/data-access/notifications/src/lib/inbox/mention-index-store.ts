import { InjectionToken } from '@angular/core';
import { IndexedDbMentionStore } from './indexed-db-mention-store';

export const MENTION_ROW_LIMIT = 2_000;
export const MENTION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** A message that mentioned the person. Holds no text, sender or key material. */
export interface MentionRecord {
  readonly eventId: string;
  readonly roomId: string;
  readonly ts: number;
}

export interface MentionCursor {
  readonly ts: number;
  readonly eventId: string;
}

export interface MentionIndexStore {
  put(accountId: string, record: MentionRecord, now: number): Promise<void>;
  /** Newest first, strictly before `before`, never older than the age limit. */
  page(
    accountId: string,
    before: MentionCursor | null,
    limit: number,
    now: number,
  ): Promise<readonly MentionRecord[]>;
  remove(accountId: string, eventIds: readonly string[]): Promise<void>;
  /** Rows of one account, or of every account. */
  count(accountId?: string): Promise<number>;
  clearAccount(accountId: string): Promise<void>;
  keepOnlyAccounts(accountIds: readonly string[]): Promise<void>;
  /** Rejects unless the database is gone. */
  deleteAll(): Promise<void>;
}

export const MENTION_INDEX_STORE = new InjectionToken<MentionIndexStore>(
  'MENTION_INDEX_STORE',
  {
    providedIn: 'root',
    factory: () => new IndexedDbMentionStore(globalThis.indexedDB),
  },
);

/** Rows to delete, given one account's rows; pure so the limits are unit-tested. */
export function rowsPastLimits(
  rows: readonly MentionCursor[],
  now: number,
): readonly string[] {
  const oldest = now - MENTION_MAX_AGE_MS;
  const expired = rows.filter((row) => row.ts < oldest);
  const newestFirst = rows
    .filter((row) => row.ts >= oldest)
    .sort((a, b) => b.ts - a.ts || (a.eventId < b.eventId ? 1 : -1));
  return [...expired, ...newestFirst.slice(MENTION_ROW_LIMIT)].map(
    (row) => row.eventId,
  );
}
