import {
  type Signal,
  computed,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  type MessageView,
  type ThreadSummary,
} from '@trinity/data-access/timeline';
import {
  dayLabel,
  hasUsableTimestamp,
  startOfLocalDay,
} from '@trinity/util/matrix';
import { DateTimeFormatService } from '@trinity/platform-native';
import { groupSystemRuns } from './system-runs';
import { DayBoundaryService } from './day-boundary.service';
import { type MessageRow } from '../message-row/message-row.component';

/** A memoized row, with the inputs it was derived from (see {@link MessageRowModel.rows}). */
interface RowCacheEntry {
  view: MessageView;
  showHeader: boolean;
  daySeparator: string | null;
  row: MessageRow;
  /** The derivation that last produced the row; an older one means its message has left. */
  pass: number;
}

/**
 * The Discord-style row grouping of the room timeline: day separators, sender headers, folded
 * system runs and their caches. Owned by {@link MessageListBase}, created in its field initializer.
 */
export class MessageRowModel {
  private readonly dayBoundary = inject(DayBoundaryService);
  private readonly dateFormat = inject(DateTimeFormatService);

  constructor(
    private readonly messages: Signal<MessageView[]>,
    private readonly firstUnreadId: Signal<string | null>,
    private readonly threadSummaries: Signal<Record<string, ThreadSummary>>,
  ) {}

  // Cached per event id so an unchanged message (same view, header flag and day-separator
  // label) keeps its row identity and the OnPush row re-renders only when its own data changes.
  // Updated in place so a page of history allocates only for its own rows.
  private readonly rowCache = new Map<string, RowCacheEntry>();
  private rowPass = 0;

  /**
   * Group consecutive messages from the same sender (Discord-style) and mark local day changes.
   *
   * Both derive over the FULL list: the windowed list renders a `slice()`, so anything derived
   * from the previous *rendered* row would emit a spurious separator at every window top and
   * lose the one where a window opens mid-day.
   */
  private readonly eventRows = computed<MessageRow[]>(() => {
    const GAP_MS = 5 * 60 * 1000;
    const msgs = this.messages();
    const todayStart = this.dayBoundary.todayStart();
    // Read unconditionally: a single-day window must still re-derive when the format preference
    // moves, or the first separator after a backfill would carry the old one.
    const dateFormat = this.dateFormat.prefs();
    const pass = ++this.rowPass;
    let visited = 0;
    // The calendar day of the rows so far, or null before the first usable timestamp. A missing
    // or implausible timestamp (degraded to `timestamp: 0`) neither opens nor closes a day, so it
    // mints no 1970 separator and the next real row is compared against the last real day.
    let currentDayStart: number | null = null;
    const result = msgs.map((m, i) => {
      const prev = msgs[i - 1];

      let daySeparator: string | null = null;
      if (hasUsableTimestamp(m.timestamp)) {
        const dayStart = startOfLocalDay(m.timestamp);
        // No separator above the FIRST row: the window is an arbitrary slice of history, and a
        // separator at the top would jump to a different row on every backfilled page.
        if (currentDayStart !== null && dayStart !== currentDayStart) {
          daySeparator = dayLabel(dayStart, todayStart, dateFormat);
        }
        currentDayStart = dayStart;
      }

      const showHeader =
        !prev ||
        // A system line breaks the group so the next message re-shows its author.
        prev.kind === 'event' ||
        prev.senderId !== m.senderId ||
        m.timestamp - prev.timestamp > GAP_MS ||
        // Same for midnight: a headerless continuation under a day separator reads as authorless.
        daySeparator !== null ||
        // A reply always shows its header: the quoted preview breaks the flow.
        !!m.replyTo;

      let entry = this.rowCache.get(m.id);
      if (
        !entry ||
        entry.view !== m ||
        entry.showHeader !== showHeader ||
        entry.daySeparator !== daySeparator
      ) {
        const row: MessageRow = { ...m, showHeader, daySeparator };
        entry = { view: m, showHeader, daySeparator, row, pass: 0 };
        this.rowCache.set(m.id, entry);
      }
      if (entry.pass !== pass) {
        entry.pass = pass;
        visited++;
      }
      return entry.row;
    });
    // Forget rows of messages that have left (trimmed, redacted, re-keyed).
    if (visited !== this.rowCache.size) {
      for (const [id, entry] of this.rowCache) {
        if (entry.pass !== pass) this.rowCache.delete(id);
      }
    }
    return result;
  });

  // Group rows from the previous pass, so an unchanged run keeps its identity (`groupSystemRuns`).
  private groupCache: ReadonlyMap<string, MessageRow> = new Map();

  /** Event rows with each run of adjacent system lines folded into one summary row. */
  private readonly grouping = computed(() => {
    const grouped = groupSystemRuns(
      this.eventRows(),
      this.firstUnreadId(),
      this.groupCache,
    );
    this.groupCache = new Map(
      grouped.rows.filter((row) => row.systemRun).map((row) => [row.id, row]),
    );
    return grouped;
  });

  /** The grouped rows the list renders. */
  readonly rows = computed(() => this.grouping().rows);

  /** Member event id → the id of the group row that holds it. */
  readonly runOf = computed(() => this.grouping().runOf);

  private readonly expandedRunIds = signal<ReadonlySet<string>>(new Set());
  /** Group rows the reader has expanded; in memory only, cleared on a room switch. */
  readonly expandedRuns = this.expandedRunIds.asReadonly();

  toggleRun(groupId: string): void {
    this.expandedRunIds.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
  }

  /** The row to scroll to for an event: itself, or its group expanded so the line is on screen. */
  revealEvent(eventId: string): string {
    // Untracked: jump effects must fire on a new request only, not on every timeline change.
    return untracked(() => {
      const groupId = this.runOf().get(eventId);
      if (!groupId) return eventId;
      if (!this.expandedRunIds().has(groupId)) this.toggleRun(groupId);
      return groupId;
    });
  }

  /** The row the "New messages" divider sits above (a run splits at the first unread). */
  readonly unreadRowId = computed(() => {
    const id = this.firstUnreadId();
    return id ? (this.runOf().get(id) ?? id) : null;
  });

  /** Rows whose avatar column continues to a later thread in the same sender group. */
  readonly threadContinuationIds = computed<ReadonlySet<string>>(() => {
    const rows = this.rows();
    const summaries = this.threadSummaries();
    const connected = new Set<string>();
    let threadBelow = false;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row.kind === 'event') {
        threadBelow = false;
        continue;
      }
      if (threadBelow) connected.add(row.id);
      if (summaries[row.id]) threadBelow = true;
      if (row.showHeader) threadBelow = false;
    }
    return connected;
  });

  /** Drop the caches and expanded runs on a room switch. */
  reset(): void {
    this.rowCache.clear();
    this.groupCache = new Map();
    this.expandedRunIds.set(new Set());
  }
}
