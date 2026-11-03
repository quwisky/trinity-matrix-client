import { DOCUMENT, Location, NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EnvironmentInjector,
  Injector,
  afterNextRender,
  computed,
  createEnvironmentInjector,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  TrnDialogRef,
  TrnSurfaceService,
  TrnSettingsLayoutComponent,
  type TrnSettingsLayoutSection,
} from '@trinity/components/overlay';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { BUILD_INFO, HapticsService } from '@trinity/platform-native';
import { TrnButton } from '@trinity/components/controls';
import {
  WhatsNewService,
  WHATS_NEW_LAUNCHER,
} from '@trinity/data-access/whats-new';
import { textScaledViewportSignal } from '@trinity/util/ui';
import { of } from 'rxjs';
import { provideConfigEditor } from '../advanced/config-editor-loader';
import {
  SETTINGS_SECTIONS,
  matchingSettingsSections,
  sectionsOfResults,
  type SettingsSearchResult,
  type SettingsSectionDefinition,
} from '../settings-sections';
import { SettingsDirectorySearchComponent } from '../shared/settings-directory-search/settings-directory-search.component';

/** History-state key on an entry a compact Settings sheet pushed for one of its sections. */
const SHEET_SECTION = 'trinitySettingsSection';

/** The sheet that pushed the entry, the section it opened, and how many entries it stands on. */
interface SheetSectionMark {
  readonly sheet: string;
  readonly section: string;
  readonly depth: number;
}

let sheetsOpened = 0;

@Component({
  selector: 'trn-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgComponentOutlet,
    TrnButton,
    TrnSettingsLayoutComponent,
    SettingsDirectorySearchComponent,
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss',
})
export class SettingsDialogComponent {
  private readonly ref = inject(TrnDialogRef<void>);
  private readonly build = inject(BUILD_INFO);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly environmentInjector = inject(EnvironmentInjector);
  private readonly document = inject(DOCUMENT);
  private readonly dialog = inject(TrnSurfaceService);
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly haptics = inject(HapticsService);
  /** Tells this sheet's history entries from another's, including one before a reload. */
  private readonly sheet = `${Date.now()}-${++sheetsOpened}`;
  /** How many of this sheet's section entries lie above the entry it opened on. */
  private depth = 0;
  /** The section leaving was swiped off already, so it draws no slide. */
  private swiped = false;
  private readonly layout = viewChild(TrnSettingsLayoutComponent);
  private readonly directorySearch = viewChild(
    SettingsDirectorySearchComponent,
  );
  private readonly notes = inject(WhatsNewService).all;
  private readonly whatsNew = inject(WHATS_NEW_LAUNCHER, { optional: true });
  private appliedInitialSection?: string;

  readonly initialSection = input<string>();
  readonly initialSource = input<string>();
  /** A part of the initial section to scroll to; the dialog owns no URL, so none is written back. */
  readonly initialPart = input<string | null>(null);
  readonly query = signal('');
  /**
   * The part the layout should scroll to. It follows the layout's own scroll tracking, so
   * picking a part again after scrolling away still scrolls; the dialog writes no URL.
   */
  readonly partTarget = linkedSignal<string | null>(() => this.initialPart());
  readonly results = computed(() => matchingSettingsSections(this.query()));
  readonly layoutSections = computed<readonly TrnSettingsLayoutSection[]>(() =>
    sectionsOfResults(this.results()).map(({ path, label, icon, group }) => ({
      id: path,
      label,
      icon,
      group,
    })),
  );
  readonly buildLabel = `Trinity v${this.build.version} · ${this.build.commit}`;
  readonly wide = textScaledViewportSignal(48, this.destroyRef);
  readonly selectedPath = signal<string | null>(null);
  /** A compact section sliding over the directory or off it, as a room slides over its list. */
  readonly slide = signal<'open' | 'close' | null>(null);
  /** The section on screen: the open one, or the one sliding off until its slide ends. */
  readonly shownPath = linkedSignal<string | null, string | null>({
    source: this.selectedPath,
    computation: (path, previous) =>
      path ?? (this.slide() === 'close' ? (previous?.value ?? null) : null),
  });
  readonly selectedSection = computed(() =>
    SETTINGS_SECTIONS.find((item) => item.path === this.shownPath()),
  );
  readonly sectionInputs = computed<Record<string, unknown>>(() =>
    this.shownPath() === 'stickers' && this.initialSource()
      ? { initialSource: this.initialSource() }
      : this.shownPath() === 'security' || this.shownPath() === 'devices'
        ? { inSettingsDialog: true }
        : {},
  );
  readonly advancedInjector = createEnvironmentInjector(
    [provideConfigEditor()],
    this.environmentInjector,
  );

  constructor() {
    // On a phone sheet or small screen, Back steps from a section to the list first; with
    // the list showing, Settings offers nothing and its opener closes the dialog.
    const unregister = inject(WorkspaceBackService).register({
      surface: () => {
        const section = this.selectedPath();
        return !this.wide() && section !== null
          ? { layer: 'application', surface: { kind: 'settings', section } }
          : null;
      },
      dismiss: () => {
        this.goBackOrClose();
        return of('dismissed' as const);
      },
      ownsTopmostOverlay: () => this.dialog.isTopmost(this.ref),
    });
    this.destroyRef.onDestroy(unregister);
    this.destroyRef.onDestroy(() => this.advancedInjector.destroy());
    const pops = this.location.subscribe(({ state }) => this.onPop(state));
    this.destroyRef.onDestroy(() => {
      pops.unsubscribe();
      // Closed by ×, the scrim or a drag over its own entries: take them off. A navigation
      // away is already writing history, and a step back now would undo it.
      if (
        this.depth > 0 &&
        this.markOf(this.location.getState()) &&
        !this.router.currentNavigation()
      ) {
        this.location.historyGo(-this.depth);
      }
    });
    effect(() => {
      const initial = this.initialSection();
      if (
        initial &&
        initial !== this.appliedInitialSection &&
        SETTINGS_SECTIONS.some((item) => item.path === initial)
      ) {
        this.appliedInitialSection = initial;
        // The sheet arrives with its section, so no slide; Back still steps to the list.
        untracked(() => this.open(initial, false));
        return;
      }
      if (this.wide() && this.selectedPath() === null) {
        this.selectedPath.set(SETTINGS_SECTIONS[0].path);
      }
    });
  }

  selectSection(path: string): void {
    this.open(path);
    this.partTarget.set(null);
    this.focusSectionHeadingLater();
  }

  /** Open the section of a search hit, then scroll to the part it names. */
  openResult({ section, part }: SettingsSearchResult): void {
    this.open(section.path);
    this.partTarget.set(part?.id ?? null);
    this.clearRouteFocusTargets();
    // The layout focuses the part's heading itself once it has scrolled there.
    if (!part) {
      this.focusSectionHeadingLater();
    }
  }

  private focusSectionHeadingLater(): void {
    afterNextRender(() => this.layout()?.focusSectionHeading(), {
      injector: this.injector,
    });
  }

  sectionInjector(section: SettingsSectionDefinition): EnvironmentInjector {
    return section.path === 'advanced'
      ? this.advancedInjector
      : this.environmentInjector;
  }

  goBackOrClose(): void {
    if (!this.wide() && this.selectedPath()) {
      // The section's own entry: popping it lands in `onPop`, as browser Back does.
      if (this.depth > 0) {
        this.location.back();
        return;
      }
      this.show(null);
      return;
    }
    this.ref.close();
  }

  /** A section swiped back from the edge, as the drawer and sheet swipes commit. */
  swipeBack(): void {
    this.haptics.gestureCommitted();
    this.swiped = true;
    this.goBackOrClose();
  }

  /**
   * Open a section. A compact sheet gives it a history entry of its own, marked so a step
   * back lands in {@link onPop} instead of leaving the room underneath.
   */
  private open(path: string, slide = true): void {
    if (!this.wide() && path !== this.selectedPath()) {
      const state = this.location.getState();
      this.depth += 1;
      this.location.go(this.location.path(true), '', {
        ...(typeof state === 'object' ? state : {}),
        [SHEET_SECTION]: {
          sheet: this.sheet,
          section: path,
          depth: this.depth,
        } satisfies SheetSectionMark,
      });
    }
    this.show(path, slide);
  }

  /**
   * A history step between this sheet's own entries. The URL stays the same, so the router
   * skips it and runs no guard; the sheet follows the entry it landed on.
   */
  private onPop(state: unknown): void {
    const mark = this.markOf(state);
    // Not from one of this sheet's entries: the router's step, which its guard owns.
    if (this.depth === 0 && !mark) return;
    if (!this.dialog.isTopmost(this.ref)) {
      // With nothing to guard, Back would change the section under the dialog above: close
      // that instead, and put the step back.
      this.dialog.closeTopmost();
      this.location.forward();
      return;
    }
    this.depth = mark?.depth ?? 0;
    this.show(mark?.section ?? null);
  }

  private show(path: string | null, slide = true): void {
    const previous = this.selectedPath();
    const swiped = this.swiped;
    this.swiped = false;
    if (path === previous) return;
    if (
      slide &&
      !swiped &&
      !this.wide() &&
      (path === null) !== (previous === null)
    ) {
      this.slide.set(path === null ? 'close' : 'open');
    }
    this.selectedPath.set(path);
    if (path !== null || previous === null) return;
    afterNextRender(
      () => {
        if (this.layoutSections().some(({ id }) => id === previous)) {
          this.layout()?.focusSectionLink(previous);
        } else {
          this.directorySearch()?.focus();
        }
      },
      { injector: this.injector },
    );
  }

  private markOf(state: unknown): SheetSectionMark | null {
    if (typeof state !== 'object' || state === null) return null;
    const mark: unknown = (state as Record<string, unknown>)[SHEET_SECTION];
    return typeof mark === 'object' &&
      mark !== null &&
      (mark as SheetSectionMark).sheet === this.sheet &&
      typeof (mark as SheetSectionMark).section === 'string' &&
      typeof (mark as SheetSectionMark).depth === 'number'
      ? (mark as SheetSectionMark)
      : null;
  }

  close(): void {
    this.ref.close();
  }

  /** Clear stale routed focus hooks before a modal section owns focus. */
  clearRouteFocusTargets(): void {
    for (const target of this.document.querySelectorAll<HTMLElement>(
      '[data-route-focus]',
    )) {
      delete target.dataset['routeFocus'];
    }
  }
}
