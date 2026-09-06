import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { TrnOverlaySurfaceDirective } from '../surface/trn-overlay-surface.directive';

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
  imports: [TrnButton, TrnIconComponent, TrnOverlaySurfaceDirective],
  templateUrl: './trn-settings-layout.component.html',
  styleUrl: './trn-settings-layout.component.scss',
})
export class TrnSettingsLayoutComponent {
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
  /** Optional host presentation; pane navigation still follows compact. */
  readonly surfaceLayout = input<'workspace' | 'fullscreen' | 'sheet' | null>(
    null,
  );
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
  /** Optional compatibility hook for the close action. */
  readonly closeTestId = input<string | null>(null);

  readonly sectionSelected = output<string>();
  readonly backRequested = output<void>();
  readonly closeRequested = output<void>();

  protected readonly directoryLabel = computed(
    () => `${this.title()} sections`,
  );
  protected readonly resolvedSurfaceLayout = computed(
    () => this.surfaceLayout() ?? (this.compact() ? 'fullscreen' : 'workspace'),
  );
  protected readonly surfaceHeight = computed(() =>
    this.resolvedSurfaceLayout() === 'sheet'
      ? 'calc(100dvh - max(0.75rem, env(safe-area-inset-top)))'
      : this.compact()
        ? '100dvh'
        : null,
  );
  protected readonly resolvedCloseTestId = computed(
    () => this.closeTestId() ?? `${this.testId()}-cancel`,
  );
  protected readonly detailClasses = computed(() =>
    ['settings-layout__detail', this.detailClass()].filter(Boolean).join(' '),
  );
  protected readonly resolvedDetailTestId = computed(
    () => this.detailTestId() ?? `${this.testId()}-detail`,
  );

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
