import {
  MENTION_MAX_AGE_MS,
  rowsPastLimits,
  type MentionCursor,
  type MentionIndexStore,
  type MentionRecord,
} from './mention-index-store';

/** An in-memory store with the real one's limits, and failures on demand. */
export class FakeMentionStore implements MentionIndexStore {
  private readonly byAccount = new Map<string, Map<string, MentionRecord>>();
  private putError: unknown = null;
  private readsFail = false;
  deleted = false;

  failNextPut(error: unknown): void {
    this.putError = error;
  }

  failReads(): void {
    this.readsFail = true;
  }

  rows(accountId: string): readonly MentionRecord[] {
    return [...(this.byAccount.get(accountId)?.values() ?? [])];
  }

  put(accountId: string, record: MentionRecord, now: number): Promise<void> {
    if (this.putError !== null) {
      const error = this.putError;
      this.putError = null;
      return Promise.reject(error);
    }
    const rows = this.byAccount.get(accountId) ?? new Map();
    rows.set(record.eventId, { ...record });
    this.byAccount.set(accountId, rows);
    for (const eventId of rowsPastLimits([...rows.values()], now)) {
      rows.delete(eventId);
    }
    return Promise.resolve();
  }

  page(
    accountId: string,
    before: MentionCursor | null,
    limit: number,
    now: number,
  ): Promise<readonly MentionRecord[]> {
    if (this.readsFail) {
      return Promise.reject(new Error('read failed'));
    }
    return Promise.resolve(
      this.rows(accountId)
        .filter(
          (row) =>
            row.ts >= now - MENTION_MAX_AGE_MS &&
            (!before ||
              row.ts < before.ts ||
              (row.ts === before.ts && row.eventId < before.eventId)),
        )
        .sort((a, b) => b.ts - a.ts || (a.eventId < b.eventId ? 1 : -1))
        .slice(0, limit),
    );
  }

  remove(accountId: string, eventIds: readonly string[]): Promise<void> {
    for (const id of eventIds) {
      this.byAccount.get(accountId)?.delete(id);
    }
    return Promise.resolve();
  }

  count(accountId?: string): Promise<number> {
    if (this.readsFail) {
      return Promise.reject(new Error('read failed'));
    }
    const accounts =
      accountId === undefined ? [...this.byAccount.keys()] : [accountId];
    return Promise.resolve(
      accounts.reduce((sum, id) => sum + this.rows(id).length, 0),
    );
  }

  clearAccount(accountId: string): Promise<void> {
    this.byAccount.delete(accountId);
    return Promise.resolve();
  }

  keepOnlyAccounts(accountIds: readonly string[]): Promise<void> {
    for (const id of [...this.byAccount.keys()]) {
      if (!accountIds.includes(id)) {
        this.byAccount.delete(id);
      }
    }
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.byAccount.clear();
    this.deleted = true;
    return Promise.resolve();
  }
}
