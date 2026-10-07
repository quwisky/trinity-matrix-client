import { DOCUMENT, Location } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';
import {
  TrnSettingsLayoutComponent,
  type TrnSettingsLayoutSection,
} from '@trinity/components/overlay';
import { BUILD_INFO } from '@trinity/platform-native';
import { textScaledViewportSignal } from '@trinity/util/ui';
import {
  SETTINGS_SECTIONS,
  matchingSettingsSections,
  sectionsOfResults,
  type SettingsSearchResult,
} from '../settings-sections';
import { SettingsDirectorySearchComponent } from '../shared/settings-directory-search/settings-directory-search.component';

/**
 * Settings shell: a submenu of sections beside a routed detail outlet. On the wide
 * layout (≥768px) both panes show at once (two-pane) and the bare `/settings` index
 * auto-selects the first section; on narrow the index shows the category list and
 * opening one swaps to its sub-page (the header's back returns to the list).
 */
@Component({
  selector: 'trn-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
  // The page sits on the app's content surface, matching the rooms main pane and thread
  // panels; painting the host covers the transparent header + panes (else it falls back to
  // the darker shell background, which is wrong in dark mode). Its panes own scrolling, so
  // clip their overflow at the shell: without this a framed Electron viewport can include
  // descendant overflow in the document and paint a second scrollbar beside the detail pane.
  host: {
    class: 'settings-page',
    '(keydown.escape)': 'onEscape($event)',
  },
  imports: [
    SettingsDirectorySearchComponent,
    TrnSettingsLayoutComponent,
    RouterOutlet,
  ],
})
export class SettingsPage {
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly build = inject(BUILD_INFO);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private lastFocusedSection: string | null = null;

  readonly query = signal('');
  readonly results = computed(() => matchingSettingsSections(this.query()));
  readonly menu = computed(() => sectionsOfResults(this.results()));
  protected readonly layoutSections = computed<
    readonly TrnSettingsLayoutSection[]
  >(() =>
    this.menu().map(({ path, label, icon, group }) => ({
      id: path,
      label,
      icon,
      group,
    })),
  );
  /** A narrow directory click adds `/settings` behind the section in history. */
  private readonly narrowSectionPushed = signal(false);

  /** "Trinity v0.0.1 · a1b2c3d" for the settings footer. */
  readonly buildLabel = `Trinity v${this.build.version} · ${this.build.commit}`;

  /** The active section path (e.g. 'profile'), or null on the bare `/settings` index. */
  protected readonly activePath = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.currentSection()),
    ),
    { initialValue: this.currentSection() },
  );

  /** The URL fragment names the part of the open section to scroll to. */
  protected readonly fragment = toSignal(this.route.fragment, {
    initialValue: null,
  });

  /**
   * The part to scroll to: the fragment, then whatever the user picked or scrolled to.
   * The address bar mirrors it without telling the router, so a part result for the part
   * the router still holds is set here directly instead of through a navigation.
   */
  protected readonly partTarget = linkedSignal<string | null>(() =>
    this.fragment(),
  );

  /** The open section's name, the page's h1. */
  protected readonly activeLabel = computed(
    () =>
      SETTINGS_SECTIONS.find((item) => item.path === this.activePath())
        ?.label ?? null,
  );

  /** Whether a section detail is open — drives the mobile list ↔ detail swap. */
  readonly sectionActive = computed(() => this.activePath() !== null);

  /**
   * Wide layout: both panes show, the index auto-selects the first section, and
   * section links replace rather than push (lateral switches must not stack history,
   * so one Back leaves settings instead of retracing visited sections). Template-read.
   * The same text-scaled 48rem signal as the settings dialog, so both presentations
   * switch layout at the same width.
   */
  protected readonly wide = textScaledViewportSignal(48, this.destroyRef);

  constructor() {
    // Browser Back, Android hardware Back and iOS history gestures bypass goBack(). When
    // one of them pops a narrow drill-in back to the directory, clear the remembered push
    // and mark its originating link before the shell's NavigationEnd focus pass runs.
    effect(() => {
      if (this.activePath() !== null || !this.narrowSectionPushed()) {
        return;
      }
      this.markDirectoryFocusTarget();
      this.narrowSectionPushed.set(false);
    });

    // The wide two-pane layout must never show an empty detail pane: land the bare
    // `/settings` index on the first section. Narrow leaves the index on the list.
    effect(() => {
      const wide = this.wide();
      if (wide && !this.sectionActive()) {
        void this.router.navigate([SETTINGS_SECTIONS[0].path], {
          relativeTo: this.route,
          replaceUrl: true,
        });
      }
    });
  }

  /** Mark the activated child heading as the app shell's route-focus destination. */
  onSectionActivated(): void {
    afterNextRender(
      () => {
        const heading = this.host.nativeElement.querySelector<HTMLElement>(
          '[data-testid="settings-detail"] h1',
        );
        if (!heading) {
          return;
        }
        this.clearRouteFocusTargets();
        heading.dataset['routeFocus'] = '';
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        this.lastFocusedSection = this.currentSection();
      },
      { injector: this.injector },
    );
  }

  /** Restore the originating entry, or search when the open section was filtered out. */
  private markDirectoryFocusTarget(): void {
    const path = this.currentSection() ?? this.lastFocusedSection;
    if (!path) {
      return;
    }
    this.clearRouteFocusTargets();
    const directory = this.host.nativeElement;
    const focusTarget =
      directory.querySelector<HTMLElement>(
        `[data-testid="settings-nav-${path}"]`,
      ) ??
      directory.querySelector<HTMLElement>('[data-testid="settings-search"]');
    if (focusTarget) {
      focusTarget.dataset['routeFocus'] = '';
    }
  }

  private clearRouteFocusTargets(): void {
    for (const target of this.document.querySelectorAll<HTMLElement>(
      '[data-route-focus]',
    )) {
      delete target.dataset['routeFocus'];
    }
  }

  /** Remember the one history entry a mobile drill-in adds behind its detail route. */
  onSectionNavigate(): void {
    if (!this.wide()) {
      this.narrowSectionPushed.set(true);
    }
  }

  /** Open a section from the directory; wide switches replace history. */
  protected selectSection(path: string, part?: string): void {
    this.onSectionNavigate();
    void this.router.navigate([path], {
      relativeTo: this.route,
      replaceUrl: this.wide(),
      fragment: part,
    });
  }

  /** Open the section of a search hit; the fragment names the part to scroll to. */
  protected openResult({ section, part }: SettingsSearchResult): void {
    if (part && section.path === this.activePath()) {
      this.partTarget.set(part.id);
    }
    this.selectSection(section.path, part?.id);
  }

  protected onPartSelected(part: string | null): void {
    this.partTarget.set(part);
    this.setFragment(part);
  }

  /**
   * Mirror the current part (or clear an unknown one) in the URL without a history entry.
   * This rewrites the address bar directly: a router navigation would run the shell's
   * route-focus pass and pull focus off the heading the user just reached.
   */
  protected setFragment(part: string | null): void {
    this.location.replaceState(
      this.location.path() + (part ? `#${part}` : ''),
      '',
      this.location.getState(),
    );
  }

  /**
   * Escape closes the page like its close button. The layout takes the compact "back"
   * step first, and an expanded select or popover trigger closes itself first.
   */
  protected onEscape(event: Event): void {
    if (
      event.defaultPrevented ||
      (event.target as Element | null)?.closest?.('[aria-expanded="true"]')
    ) {
      return;
    }
    event.preventDefault();
    this.close();
  }

  /** Leave settings altogether, whichever pane is open. */
  protected close(): void {
    if (this.narrowSectionPushed()) {
      this.narrowSectionPushed.set(false);
      this.location.historyGo(-2);
      return;
    }
    this.location.back();
  }

  /**
   * Header back/up. On the narrow single-pane layout the category list is hidden
   * while a section is open, so this is the only route back to it — go up to the
   * index explicitly (history may not hold it after a deep-link or reload). Otherwise
   * (the list itself, or the desktop two-pane) step out of settings through history.
   */
  goBack(): void {
    if (!this.wide() && this.sectionActive()) {
      this.markDirectoryFocusTarget();
      if (this.narrowSectionPushed()) {
        this.narrowSectionPushed.set(false);
        this.location.back();
        return;
      }
      // Up to the list, replacing the section so a later Back doesn't retrace into it.
      void this.router.navigate(['/settings'], { replaceUrl: true });
      return;
    }
    if (this.wide() && this.narrowSectionPushed()) {
      this.narrowSectionPushed.set(false);
      this.location.historyGo(-2);
      return;
    }
    this.location.back();
  }

  // Read the section from the router URL, not `route.firstChild`: on a deep link /
  // reload the shell constructs before the child route activates, so `firstChild`
  // is briefly null — which would make the wide effect wrongly redirect a directly
  // opened section (e.g. /settings/devices) to the first one.
  private currentSection(): string | null {
    return /^\/settings\/([^/?#]+)/.exec(this.router.url)?.[1] ?? null;
  }
}
