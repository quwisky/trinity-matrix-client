import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { TrnSettingsParts } from './trn-settings-parts';

/** One selectable entry in a domain-neutral settings directory. */
export interface TrnSettingsLayoutSection {
  readonly id: string;
  readonly label: string;
  readonly icon: TrnIconName;
  readonly group?: string;
}

@Component({
  selector: 'trn-settings-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, TrnButton, TrnIconComponent],
  providers: [TrnSettingsParts],
  templateUrl: './trn-settings-layout.component.html',
  styleUrl: './trn-settings-layout.component.scss',
  host: { '(keydown.escape)': 'onEscape($event)' },
})
export class TrnSettingsLayoutComponent {
  private readonly registry = inject(TrnSettingsParts);
  private readonly destroyRef = inject(DestroyRef);
  private shownSection: string | null | undefined;
  private pendingPart: string | null = null;
  private visibleParts = new Set<string>();
  private lastEmitted: string | null = null; // null: no fragment
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private lockTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollLocked = false;
  private readonly directory = viewChild<ElementRef<HTMLElement>>('directory');
  private readonly detail = viewChild<ElementRef<HTMLElement>>('detail');

  /** Plain-text title for the shared header. */
  readonly title = input.required<string>();
  /** Ordered entries for the left directory. */
  readonly sections = input<readonly TrnSettingsLayoutSection[]>([]);
  /** The selected entry, or null while a compact layout shows only its directory. */
  readonly selectedSection = input<string | null>(null);
  /** Whether this presentation fills the viewport and swaps directory/detail panes. */
  readonly compact = input(false);
  /** Whether the directory pane is presently visible. */
  readonly directoryVisible = input(true);
  /** Stable base for this layout's public test hooks. */
  readonly testId = input('settings');
  /** Consumer-owned class hook for the scrolling detail pane. */
  readonly detailClass = input('');
  /** Optional compatibility hook for the scrolling detail pane. */
  readonly detailTestId = input<string | null>(null);
  /** Optional compatibility prefix for directory item test hooks. */
  readonly navItemTestIdPrefix = input<string | null>(null);
  /** Accessible name of the close action. */
  readonly closeLabel = input('Close settings');
  /** Optional compatibility hook for the close action. */
  readonly closeTestId = input<string | null>(null);

  /** A part of the open section to scroll to once it has rendered (from a URL fragment). */
  readonly initialPart = input<string | null>(null);
  /** The part the user picked or scrolled to; null when `initialPart` names no part. */
  readonly partSelected = output<string | null>();
  readonly sectionSelected = output<string>();
  readonly backRequested = output<void>();
  readonly closeRequested = output<void>();

  /** Compact and showing only the directory: the close and title live in the list. */
  protected readonly listView = computed(
    () => this.compact() && this.directoryVisible(),
  );
  protected readonly parts = this.registry.parts;
  protected readonly currentPart = this.registry.current;
  protected readonly selectedLabel = computed(
    () => this.sections().find((s) => s.id === this.selectedSection())?.label,
  );
  protected readonly directoryLabel = computed(
    () => `${this.title()} sections`,
  );
  protected readonly resolvedCloseTestId = computed(
    () => this.closeTestId() ?? `${this.testId()}-cancel`,
  );
  protected readonly detailClasses = computed(() =>
    ['settings-layout__content', this.detailClass()].filter(Boolean).join(' '),
  );
  protected readonly resolvedDetailTestId = computed(
    () => this.detailTestId() ?? `${this.testId()}-detail`,
  );

  constructor() {
    // A section change abandons any pending or in-flight scroll and starts at the top.
    effect(() => {
      const section = this.selectedSection();
      untracked(() => {
        // The first run only records the section, so it cannot undo an initial part.
        if (this.shownSection === undefined || this.shownSection === section) {
          this.shownSection = section;
          return;
        }
        this.shownSection = section;
        this.pendingPart = null;
        this.visibleParts = new Set();
        this.lastEmitted = null;
        this.endScrollLock();
        clearTimeout(this.emitTimer);
        clearTimeout(this.settleTimer);
        this.settleTimer = undefined;
        this.registry.current.set(null);
        const detail = this.detail()?.nativeElement;
        if (detail) {
          detail.scrollTop = 0;
        }
      });
    });

    effect(() => {
      const part = this.initialPart();
      untracked(() => {
        if (part && part !== this.registry.current()) {
          this.pendingPart = part;
          clearTimeout(this.settleTimer);
          this.settleTimer = undefined;
          this.resolvePending(this.registry.parts());
        }
      });
    });

    effect(() => this.resolvePending(this.registry.parts()));

    effect((onCleanup) => {
      const parts = this.registry.parts();
      const detail = this.detail()?.nativeElement;
      if (
        !detail ||
        parts.length === 0 ||
        typeof IntersectionObserver === 'undefined'
      ) {
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = parts.find((p) => p.heading === entry.target)?.id;
            if (!id) continue;
            if (entry.isIntersecting) this.visibleParts.add(id);
            else this.visibleParts.delete(id);
          }
          this.followScroll(detail);
        },
        { root: detail, rootMargin: '0px 0px -70% 0px' },
      );
      for (const part of parts) observer.observe(part.heading);
      const onScroll = (): void => this.followScroll(detail);
      detail.addEventListener('scroll', onScroll, { passive: true });
      detail.addEventListener('scrollend', this.endScrollLock);
      onCleanup(() => {
        observer.disconnect();
        detail.removeEventListener('scroll', onScroll);
        detail.removeEventListener('scrollend', this.endScrollLock);
      });
    });

    // Keep the compact chip for the current part in view.
    effect(() => {
      const id = this.registry.current();
      this.compact();
      const row = this.detail()?.nativeElement.querySelector<HTMLElement>(
        '.settings-layout__chips',
      );
      const chip = row?.querySelector<HTMLElement>(`[data-part="${id}"]`);
      if (row && chip) {
        row.scrollLeft =
          chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2;
      }
    });

    this.destroyRef.onDestroy(() => {
      clearTimeout(this.emitTimer);
      clearTimeout(this.lockTimer);
      clearTimeout(this.settleTimer);
    });
  }

  /**
   * Scroll to the pending part once registered. A part that is still absent a moment
   * later (groups may render late, e.g. behind a platform check) is reported as unknown.
   */
  private resolvePending(parts: readonly { id: string }[]): void {
    untracked(() => {
      const id = this.pendingPart;
      if (!id) {
        return;
      }
      if (parts.some((p) => p.id === id)) {
        clearTimeout(this.settleTimer);
        this.settleTimer = undefined;
        this.goToPart(id);
      } else if (this.settleTimer === undefined) {
        this.settleTimer = setTimeout(() => {
          this.settleTimer = undefined;
          if (this.pendingPart === id) {
            this.pendingPart = null;
            this.partSelected.emit(null);
          }
        }, 1000);
      }
    });
  }

  protected goToPart(id: string): void {
    const part = this.registry.parts().find((p) => p.id === id);
    if (!part) {
      return;
    }
    this.pendingPart = null;
    const reduce =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The spy ignores the headings a smooth scroll passes over until it settles.
    if (!reduce) {
      this.scrollLocked = true;
      clearTimeout(this.lockTimer);
      this.lockTimer = setTimeout(this.endScrollLock, 800);
    }
    part.heading.scrollIntoView({
      behavior: reduce ? 'auto' : 'smooth',
      block: 'start',
    });
    part.heading.focus({ preventScroll: true });
    this.registry.current.set(id);
    this.emitNow(id);
  }

  private readonly endScrollLock = (): void => {
    this.scrollLocked = false;
    clearTimeout(this.lockTimer);
  };

  private emitNow(id: string | null): void {
    clearTimeout(this.emitTimer);
    this.lastEmitted = id;
    this.partSelected.emit(id);
  }

  /** Top-most visible heading wins; the page ends on the last part, its top on the first. */
  private followScroll(detail: HTMLElement): void {
    if (this.scrollLocked) {
      return;
    }
    const parts = this.registry.parts();
    const scrollable = detail.scrollHeight > detail.clientHeight;
    const atBottom =
      scrollable &&
      detail.scrollTop + detail.clientHeight >= detail.scrollHeight - 1;
    const top = !atBottom && detail.scrollTop === 0;
    const id = atBottom
      ? parts.at(-1)?.id
      : (parts.find((p) => this.visibleParts.has(p.id))?.id ??
        (top ? parts[0]?.id : undefined));
    if (!id) {
      return;
    }
    this.registry.current.set(id);
    // The top of the page is the section itself: it carries no fragment.
    const emit = top ? null : id;
    clearTimeout(this.emitTimer);
    if (emit !== this.lastEmitted) {
      this.emitTimer = setTimeout(() => this.emitNow(emit), 200);
    }
  }

  /**
   * Escape closes the layer through its owner: the CDK dialog closes on a body-level
   * Escape (running the unsaved-changes guard, and giving an open inner overlay the key
   * first), so this only takes the compact "back to the list" step, which the dialog
   * cannot know about. An Escape something else already handled is left alone.
   */
  protected onEscape(event: Event): void {
    if (
      event.defaultPrevented ||
      // A select or popover trigger that is open takes this Escape to close itself.
      (event.target as Element | null)?.closest?.('[aria-expanded="true"]') ||
      !(this.compact() && this.selectedSection() && !this.directoryVisible())
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.backRequested.emit();
  }

  protected selectSection(id: string): void {
    this.sectionSelected.emit(id);
  }

  protected isGroupStart(index: number): boolean {
    const section = this.sections()[index];
    return (
      !!section?.group && this.sections()[index - 1]?.group !== section.group
    );
  }

  protected sectionTestId(section: TrnSettingsLayoutSection): string {
    return `${this.navItemTestIdPrefix() ?? `${this.testId()}-tab-`}${section.id}`;
  }

  /** Restore keyboard focus to a directory entry after its compact detail closes. */
  focusSectionLink(id: string): void {
    const link = Array.from(
      this.directory()?.nativeElement.querySelectorAll<HTMLElement>(
        '[data-trn-settings-section]',
      ) ?? [],
    ).find((element) => element.dataset['trnSettingsSection'] === id);
    link?.focus({ preventScroll: true });
  }

  /** Focus the consumer-projected section heading after selection. */
  focusSectionHeading(): void {
    const heading =
      this.detail()?.nativeElement.querySelector<HTMLElement>('h2');
    if (!heading) {
      return;
    }
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}
