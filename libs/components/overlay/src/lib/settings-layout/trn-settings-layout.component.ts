import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import { TrnDialogShellComponent } from '../dialog-shell/trn-dialog-shell.component';
import { TrnSettingsParts } from './trn-settings-parts';
import { TrnSettingsScrollSpy } from './trn-settings-scroll-spy';

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
  imports: [
    NgTemplateOutlet,
    TrnButton,
    TrnIconComponent,
    TrnDialogShellComponent,
  ],
  // A wrapper that projects the sections itself provides the registry the layout then shares:
  // projected sections resolve their injector from where they are declared, outside the layout.
  providers: [
    {
      provide: TrnSettingsParts,
      useFactory: () =>
        inject(TrnSettingsParts, { skipSelf: true, optional: true }) ??
        new TrnSettingsParts(),
    },
  ],
  templateUrl: './trn-settings-layout.component.html',
  styleUrl: './trn-settings-layout.component.scss',
  host: {
    '[attr.data-presentation]': 'framing',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class TrnSettingsLayoutComponent {
  private readonly registry = inject(TrnSettingsParts);
  private readonly directory = viewChild<ElementRef<HTMLElement>>('directory');
  private readonly detail = viewChild<ElementRef<HTMLElement>>('detail');
  private readonly scrollSpy: TrnSettingsScrollSpy;

  private readonly openedAs =
    inject(TrnDialogRef, { optional: true })?.presentation ?? null;

  /**
   * A centred dialog or a sheet is framed by the shared dialog shell and sized to it; a
   * full-screen dialog and the routed page fill the viewport.
   */
  protected readonly framing =
    this.openedAs === 'dialog' || this.openedAs === 'sheet'
      ? this.openedAs
      : 'fullscreen';

  /** Plain-text title for the shared header. */
  readonly title = input.required<string>();
  /** The open section's name: the h1 of its detail. The list view keeps `title`. */
  readonly heading = input<string | null>(null);
  /** Test id for the section h1, for the consumer whose own heading it replaced. */
  readonly headingTestId = input<string | null>(null);
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
  protected readonly headingText = computed(() =>
    this.listView() ? this.title() : (this.heading() ?? this.title()),
  );
  protected readonly parts = this.registry.parts;
  protected readonly currentPart = this.registry.current;
  /** One group is the whole page, so there is nothing to navigate between. */
  protected readonly hasParts = computed(
    () => this.registry.parts().length > 1,
  );
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
    this.scrollSpy = new TrnSettingsScrollSpy(
      this.detail,
      this.selectedSection,
      this.initialPart,
      this.compact,
      (id) => this.partSelected.emit(id),
    );
  }

  protected goToPart(id: string): void {
    this.scrollSpy.goToPart(id);
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
    // With a section title the h1 is the section's heading; without one the consumer
    // projects its own.
    const heading = this.detail()?.nativeElement.querySelector<HTMLElement>(
      this.heading() ? 'h1' : 'h2',
    );
    if (!heading) {
      return;
    }
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}
