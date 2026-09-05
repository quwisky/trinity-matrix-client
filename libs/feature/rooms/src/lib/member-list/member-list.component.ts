import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AvatarComponent } from '@trinity/components/generic-content';
import {
  MEMBER_ROLE_LABEL,
  MEMBER_ROLE_ORDER,
  type MemberRole,
  type RoomAdministrationAvailability,
  type MemberSummary,
  memberRole,
} from '@trinity/data-access/room-administration';
import { IdentityPresenceService } from '@trinity/data-access/identity';
import { type PresenceState } from '@trinity/util/matrix';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnInput } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import {
  buildPrefixSums,
  computeWindow,
  type WindowResult,
} from '../message-list/virtual-window';

/** A member decorated with their live presence and role, for the section list. */
interface MemberRow {
  readonly member: MemberSummary;
  readonly presence: PresenceState | null;
  readonly role: MemberRole;
}

/**
 * Row geometry, in pixels.
 *
 * Both are fixed by `member-list.component.scss` rather than measured, which is the one
 * meaningful difference from the timeline's use of this same windowing math: a message row
 * is whatever height its content makes it, a member row is an avatar and one ellipsised
 * line. `ROW_PX` is 32px of avatar plus 6px of padding either side; the stylesheet fixes
 * that border box at 44px for every pointer and density. If either measurement changes, the
 * spacers drift and the scrollbar lies; source and rendered-layout specs pin them together.
 */
const HEADER_PX = 34;
const ROW_PX = 44;

/** Rendered beyond the viewport on each side, so a fast scroll does not show blanks. */
const OVERSCAN_PX = 320;

/**
 * Below this many rows the list renders whole.
 *
 * Windowing costs a scroll listener, a resize observer and a prefix-sum array; a room with
 * a handful of members gets nothing back for it. The threshold is generous on purpose —
 * the failure this exists for is a five-thousand-member room, not a fifty-member one.
 */
const SMALL_LIST_ROWS = 80;

/** A role section: a labelled group of members shown under its own header. */
interface MemberSection {
  readonly role: MemberRole;
  /** Visible header, e.g. "Admin". */
  readonly label: string;
  /** Icon shown beside the header, from Trinity's vocabulary, e.g. "crown". */
  readonly icon: TrnIconName;
  /** Accessible name for the group landmark, e.g. "Admin, 2 members". */
  readonly ariaLabel: string;
  readonly rows: MemberRow[];
}

/** A section narrowed to what the scroll window actually shows. */
interface WindowedSection extends MemberSection {
  /** Whether the header's own flat index is inside the window. */
  readonly showHeader: boolean;
  /**
   * How many members the section really has.
   *
   * Separate from `rows.length`, which is the window slice: the header prints a count, and
   * printing the slice's length would make it read "Member — 16" in a 600-member room and
   * change as the reader scrolled.
   */
  readonly totalRows: number;
}

/** Sort order: online first, then away, then offline (stable within each group). */
const PRESENCE_RANK: Record<PresenceState, number> = {
  online: 0,
  unavailable: 1,
  offline: 2,
};

/**
 * Icon per role header. The owner gets the key rather than a second crown: two crown-ish
 * glyphs stacked above each other is exactly the "which of these is which?" the separate
 * section exists to remove.
 */
const ROLE_ICON: Record<MemberRole, TrnIconName> = {
  owner: 'key-round',
  admin: 'crown',
  moderator: 'shield',
  member: 'user',
};

/** Discord member list (right column): joined members grouped into role sections. */
@Component({
  selector: 'trn-member-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    TrnIconComponent,
    TrnInput,
    TrnTooltip,
    EmptyStateComponent,
  ],
  templateUrl: './member-list.component.html',
  styleUrl: './member-list.component.scss',
})
export class MemberListComponent {
  private readonly presence = inject(IdentityPresenceService);

  readonly members = input<readonly MemberSummary[]>([]);
  readonly availability = input<RoomAdministrationAvailability>('coherent');
  /**
   * Whether this is a direct message. A DM has no owner — both participants sit at power
   * level 100 by the trusted_private_chat preset — so the section is suppressed there.
   */
  readonly direct = input(false);
  /** A member row was clicked — the host opens their info panel. */
  readonly selectMember = output<MemberSummary>();

  /** What the reader typed into the filter, matched against name and user id. */
  protected readonly query = signal('');

  private readonly scrollHost =
    viewChild.required<ElementRef<HTMLElement>>('scrollHost');
  private readonly scrollTop = signal(0);
  private readonly viewportH = signal(0);

  /**
   * Every member decorated with live presence and role. Recomputes when membership,
   * any listed member's presence, or a member's power level changes.
   */
  private readonly rows = computed<MemberRow[]>(() =>
    this.members().map((member) => ({
      member,
      presence: this.presence.presenceFor(member.userId)(),
      role: memberRole(member, { direct: this.direct() }),
    })),
  );

  /**
   * The rows the filter admits.
   *
   * Name AND user id, because the two answer different questions: a reader scanning for
   * someone they can see types the display name, and one disambiguating two people with
   * the same display name types the id. Case-folded on both sides; an empty query is not
   * a filter and returns the same array reference.
   */
  private readonly matchingRows = computed<MemberRow[]>(() => {
    const needle = this.query().trim().toLowerCase();
    const rows = this.rows();
    if (!needle) {
      return rows;
    }
    return rows.filter(
      (row) =>
        row.member.roomDisplayName.toLowerCase().includes(needle) ||
        row.member.userId.toLowerCase().includes(needle),
    );
  });

  /** Whether a filter is narrowing the list, for the empty state. */
  protected readonly filtering = computed(() => this.query().trim().length > 0);

  /**
   * What the live region says while filtering.
   *
   * Windowing makes this necessary rather than nice: a sighted reader sees the list
   * shorten, but the rows outside the window are not in the DOM at all, so a screen
   * reader cannot count what is left by walking it. Empty while nothing is typed — an
   * unfiltered roster's size is the group headers' job to report.
   */
  protected readonly filterStatus = computed(() => {
    if (!this.filtering()) {
      return '';
    }
    const count = this.matchingRows().length;
    return count === 1 ? '1 member matches' : `${count} members match`;
  });

  /**
   * Members grouped into role sections (admins, then moderators, then members), each
   * ordered online-first. The incoming list is already name-sorted and both the
   * partition and the presence sort are stable, so members keep alphabetical order
   * within each presence group. Empty sections are dropped.
   */
  readonly sections = computed<MemberSection[]>(() => {
    const rows = this.matchingRows();
    return MEMBER_ROLE_ORDER.map((role) => {
      const sectionRows = rows
        .filter((row) => row.role === role)
        .sort(
          (a, b) =>
            (a.presence === null ? 3 : PRESENCE_RANK[a.presence]) -
            (b.presence === null ? 3 : PRESENCE_RANK[b.presence]),
        );
      const label = MEMBER_ROLE_LABEL[role];
      const noun = sectionRows.length === 1 ? 'member' : 'members';
      return {
        role,
        label,
        icon: ROLE_ICON[role],
        ariaLabel: `${label}, ${sectionRows.length} ${noun}`,
        rows: sectionRows,
      };
    }).filter((section) => section.rows.length > 0);
  });

  /**
   * The flat row order the windowing math sees: each section's header, then its members.
   *
   * `computeWindow` takes one `ids` array, and the list it is windowing is a set of groups
   * — so the groups are flattened here and the result is folded back into sections below.
   * Headers are rows too: leave them out and every group boundary shifts the spacers by
   * 24px, which compounds down a long list until the scrollbar is visibly wrong.
   */
  private readonly flatIds = computed<string[]>(() => {
    const ids: string[] = [];
    for (const section of this.sections()) {
      ids.push(`header:${section.role}`);
      for (const row of section.rows) {
        ids.push(`member:${row.member.userId}`);
      }
    }
    return ids;
  });

  /**
   * Heights by id.
   *
   * Fixed from CSS rather than measured, unlike the timeline's, so there is no
   * `ResizeObserver` per row and no height version to invalidate on. `estimate` covers
   * member rows; only the headers need naming.
   */
  private readonly heights = computed(() => ({
    measured: new Map(
      this.sections().map((section) => [`header:${section.role}`, HEADER_PX]),
    ),
    estimate: ROW_PX,
  }));

  private readonly prefix = computed(() =>
    buildPrefixSums(this.flatIds(), this.heights()),
  );

  private readonly windowResult = computed<WindowResult>(() =>
    computeWindow(
      {
        ids: this.flatIds(),
        heights: this.heights(),
        scrollTop: this.scrollTop(),
        viewportHeight: this.viewportH(),
        overscanPx: OVERSCAN_PX,
        // Never: a member list is read from the top. `pinBottom` is the timeline's
        // "follow the newest message", which has no meaning for an alphabetical roster.
        pinBottom: false,
        smallListThreshold: SMALL_LIST_ROWS,
        enabled: true,
      },
      this.prefix(),
    ),
  );

  /** Height of the spacer standing in for the rows scrolled off the top. */
  protected readonly topPadPx = computed(() => this.windowResult().topPadPx);
  /** Height of the spacer standing in for the rows below the window. */
  protected readonly bottomPadPx = computed(
    () => this.windowResult().bottomPadPx,
  );

  /**
   * The sections as rendered: only those overlapping the window, each sliced to it.
   *
   * Sections are contiguous in the flat order, so a global window maps onto a per-section
   * slice without any searching. A section whose header scrolled away still renders its
   * `role="group"` and its name — the header is visual, the accessible name is not.
   */
  protected readonly windowedSections = computed<WindowedSection[]>(() => {
    const { startIndex, endIndex } = this.windowResult();
    if (endIndex < 0) {
      return [];
    }
    const windowed: WindowedSection[] = [];
    let cursor = 0;
    for (const section of this.sections()) {
      const headerIndex = cursor;
      const firstRow = cursor + 1;
      const lastRow = cursor + section.rows.length;
      cursor = lastRow + 1;
      // `headerIndex`, not `firstRow`, on the right: the header is a row in the flat index
      // and `computeWindow` has already counted its height as rendered. Testing the first
      // MEMBER instead dropped a section whose header was the window's last index, leaving
      // the rendered content HEADER_PX shorter than the spacers assume.
      if (lastRow < startIndex || headerIndex > endIndex) {
        continue; // entirely outside the window — the spacers stand in for it
      }
      windowed.push({
        ...section,
        totalRows: section.rows.length,
        showHeader: headerIndex >= startIndex,
        rows: section.rows.slice(
          Math.max(0, startIndex - firstRow),
          Math.max(0, endIndex - firstRow + 1),
        ),
      });
    }
    return windowed;
  });

  constructor() {
    // The viewport height is an input to the window, so it has to be watched rather than
    // read once: the members panel shares the right-hand slot with threads and search, and
    // it is resized by the split-pane drag as well as by the browser window.
    const host = this.scrollHost;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(([entry]) =>
        this.viewportH.set(entry.contentRect.height),
      );
      afterNextRender(
        () => {
          const el = host().nativeElement;
          this.viewportH.set(el.clientHeight);
          observer.observe(el);
        },
        { injector: inject(Injector) },
      );
      inject(DestroyRef).onDestroy(() => observer.disconnect());
    }
  }

  protected onScroll(): void {
    this.scrollTop.set(this.scrollHost().nativeElement.scrollTop);
  }

  /**
   * Take the filter's new value and go back to the top of the results.
   *
   * The reset is the point. Without it, a reader scrolled deep into a long roster who
   * types a filter has the browser clamp `scrollTop` to the new, much shorter maximum —
   * landing them at the END of the matches with nothing to say there are more above. The
   * timeline's windowed list resets the same way when its row set is replaced.
   */
  protected onQuery(value: string): void {
    this.query.set(value);
    this.scrollTop.set(0);
    this.scrollHost().nativeElement.scrollTop = 0;
  }
}
