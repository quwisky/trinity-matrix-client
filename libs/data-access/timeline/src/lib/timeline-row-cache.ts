import { EventType, type MatrixEvent } from 'matrix-js-sdk';
import type { MessageShield, MessageView } from './message-presentation';

/** One loaded event's projection and what it was projected from. */
export interface ProjectedRow {
  /**
   * A message's effective content as JSON, the string `revisionOf` memoises per content
   * object; empty for a system line.
   */
  readonly content: string;
  /** Everything else the row was projected from; a system line's text. */
  readonly rest: string;
  /** Null for a system change with nothing to say, which renders no row. */
  readonly view: MessageView | null;
  /** The shield the row was projected with. Shields are interned, so identity is enough. */
  readonly shield: MessageShield | null;
  /** The event whose text and shield the row shows: its latest checked edit, else itself. */
  readonly subjectId: string;
  /** Members the row renders: sender, quoted sender, named reactors, readers, a line's target. */
  readonly members: readonly string[];
}

interface CachedRow extends ProjectedRow {
  /** The refresh that last visited the row; an older one means its event has left. */
  pass: number;
}

/**
 * The open room's projected rows, keyed by event id, and what has changed since each was
 * projected.
 *
 * A refresh re-checks only the rows something noted here may have changed and reuses every
 * other row as it is, so a page of history costs only that page, not every loaded event.
 *
 * Noting too much costs time; noting too little leaves a stale row on screen. Every listener
 * that can change a row notes what it changed, and anything that cannot be attributed to
 * particular rows re-checks them all.
 */
export class TimelineRowCache {
  private readonly rows = new Map<string, CachedRow>();
  private pass = 0;
  private visited = 0;
  private stored = 0;

  private everything = true;
  private receiptsMoved = false;
  private pollsMoved = false;
  private events = new Set<string>();
  private members = new Set<string>();

  /** What the current pass re-checks; taken from what was noted when it began. */
  private stale: {
    readonly everything: boolean;
    readonly receiptsMoved: boolean;
    readonly pollsMoved: boolean;
    readonly events: ReadonlySet<string>;
    readonly members: ReadonlySet<string>;
  } = {
    everything: true,
    receiptsMoved: false,
    pollsMoved: true,
    events: new Set(),
    members: new Set(),
  };

  /** Rows whose projection changed during the current pass: a reply quoting one re-checks. */
  private readonly changed = new Set<string>();

  get size(): number {
    return this.rows.size;
  }

  /** Re-check every row on the next pass. */
  markAll(): void {
    this.everything = true;
  }

  /**
   * An event arrived, was sent or decrypted, or now resolves to another edit. Its own row
   * changes, and so do the rows that read it: the message it relates to (a reaction, edit,
   * poll response or end, or a thread reply's root) and any reply quoting it.
   *
   * A redaction re-checks every row: by the time it is seen, the SDK has already stripped
   * the redacted event's relation, so the row that a removed reaction or vote counted on can
   * no longer be found from it.
   */
  noteEvent(event: MatrixEvent | undefined, previousId?: string): void {
    if (!event || event.getType() === EventType.RoomRedaction) {
      this.markAll();
      return;
    }
    this.note(event.getId());
    // A remote echo renames the row's event; a reply quoting the old id now quotes nothing.
    this.note(previousId);
    this.note(event.relationEventId);
  }

  /**
   * A read receipt moved. It leaves whichever row showed it, and lands on the events it
   * names; the SDK reports only where it lands.
   */
  noteReceipt(receipt: MatrixEvent | undefined): void {
    if (!receipt) {
      this.markAll();
      return;
    }
    this.receiptsMoved = true;
    for (const eventId of Object.keys(receipt.getContent())) {
      this.events.add(eventId);
    }
  }

  /** Who may end a poll changed (power levels): re-check the poll rows. */
  notePollPermissions(): void {
    this.pollsMoved = true;
  }

  /** A member's name or avatar changed: re-check the rows that render them. */
  noteMember(userId: string): void {
    this.members.add(userId);
  }

  /**
   * Start a refresh. `everything` re-checks every row whatever was noted: the timeline was
   * replaced, encryption changed, or the room was shown again.
   */
  beginPass(everything: boolean): void {
    this.pass++;
    this.visited = 0;
    this.stored = 0;
    this.changed.clear();
    this.stale = {
      everything: everything || this.everything,
      receiptsMoved: this.receiptsMoved,
      pollsMoved: this.pollsMoved,
      events: this.events,
      members: this.members,
    };
    this.everything = false;
    this.receiptsMoved = false;
    this.pollsMoved = false;
    if (this.events.size > 0) this.events = new Set();
    if (this.members.size > 0) this.members = new Set();
  }

  /**
   * The row for `eventId` when nothing it was projected from can have changed since, or
   * undefined when it must be re-checked. A reused row counts as visited by this pass.
   */
  reusable(
    eventId: string,
    replyTo: string | undefined,
    shield: MessageShield | null,
    subjectId: string = eventId,
  ): ProjectedRow | undefined {
    const row = this.rows.get(eventId);
    if (
      !row ||
      row.subjectId !== subjectId ||
      this.mustRecheck(eventId, replyTo, shield, row)
    ) {
      return undefined;
    }
    this.visit(row);
    return row;
  }

  /** The row as last projected, to compare a re-check against. */
  previous(eventId: string): ProjectedRow | undefined {
    return this.rows.get(eventId);
  }

  /**
   * Record a re-checked row. `changed` says its view is new, so replies quoting its event
   * re-check too.
   */
  store(eventId: string, row: ProjectedRow, changed: boolean): void {
    const cached: CachedRow = { ...row, pass: this.pass };
    this.rows.set(eventId, cached);
    this.visited++;
    this.stored++;
    if (changed) this.changed.add(eventId);
  }

  /**
   * Drop the rows of events this pass did not visit. Says whether any row went, and how
   * many this pass re-checked: either can change which members the rows render.
   */
  endPass(): { readonly pruned: boolean; readonly rechecked: number } {
    const pruned = this.visited !== this.rows.size;
    if (pruned) {
      for (const [eventId, row] of this.rows) {
        if (row.pass !== this.pass) this.rows.delete(eventId);
      }
    }
    return { pruned, rechecked: this.stored };
  }

  /** Every member some cached row renders. */
  renderedMembers(): Set<string> {
    const members = new Set<string>();
    for (const row of this.rows.values()) {
      for (const member of row.members) members.add(member);
    }
    return members;
  }

  /** Forget every row, and re-check everything on the next pass. */
  clear(): void {
    this.rows.clear();
    this.changed.clear();
    this.events = new Set();
    this.members = new Set();
    this.receiptsMoved = false;
    this.pollsMoved = false;
    this.everything = true;
  }

  private note(eventId: string | undefined): void {
    if (eventId) this.events.add(eventId);
  }

  private visit(row: CachedRow): void {
    row.pass = this.pass;
    this.visited++;
  }

  private mustRecheck(
    eventId: string,
    replyTo: string | undefined,
    shield: MessageShield | null,
    row: CachedRow,
  ): boolean {
    const stale = this.stale;
    if (
      stale.everything ||
      row.shield !== shield ||
      stale.events.has(eventId)
    ) {
      return true;
    }
    // The quoted message changed: the reply's preview reads its body and sender.
    if (replyTo && (stale.events.has(replyTo) || this.changed.has(replyTo))) {
      return true;
    }
    if (stale.pollsMoved && row.view?.poll) return true;
    if (stale.receiptsMoved && (row.view?.readReceipts.length ?? 0) > 0) {
      return true;
    }
    if (stale.members.size > 0) {
      for (const member of row.members) {
        if (stale.members.has(member)) return true;
      }
    }
    return false;
  }
}
