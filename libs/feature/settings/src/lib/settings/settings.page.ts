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
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { PageHeaderComponent } from '@trinity/components/navigation-layout';
import { BUILD_INFO } from '@trinity/platform-native';
import { MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { TrnIconComponent } from '@trinity/components/foundations';
import { SETTINGS_SECTIONS } from '../settings-sections';

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
  },
  imports: [
    PageHeaderComponent,
    TrnIconComponent,
    TrnButton,
    TrnTooltip,
    RouterLink,
    RouterLinkActive,
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
  private readonly nav = viewChild<ElementRef<HTMLElement>>('nav');
  private readonly detail = viewChild<ElementRef<HTMLElement>>('detail');
  private lastFocusedSection: string | null = null;

  readonly menu = SETTINGS_SECTIONS;
  /** A narrow directory click adds `/settings` behind the section in history. */
  private readonly narrowSectionPushed = signal(false);

  /** "Trinity v0.0.1 · a1b2c3d" for the settings footer. */
  readonly buildLabel = `Trinity v${this.build.version} · ${this.build.commit}`;

  /** The active section path (e.g. 'profile'), or null on the bare `/settings` index. */
  private readonly activePath = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.currentSection()),
    ),
    { initialValue: this.currentSection() },
  );

  /** Whether a section detail is open — drives the mobile list ↔ detail swap. */
  readonly sectionActive = computed(() => this.activePath() !== null);

  /**
   * Wide layout: both panes show, the index auto-selects the first section, and
   * section links replace rather than push (lateral switches must not stack history,
   * so one Back leaves settings instead of retracing visited sections). Template-read.
   *
   * This used to hand-roll `mediaQuerySignal`: the same single MediaQueryList, the same
   * seed-then-listen, the same teardown on `destroyRef` — beside its own copy of the
   * breakpoint string. Both are shared now, so the `md` boundary is defined once and the
   * live-resize behaviour cannot drift between the two screens that branch on it.
   */
  protected readonly wide = mediaQuerySignal(MD_QUERY, this.destroyRef);

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
        const heading =
          this.detail()?.nativeElement.querySelector<HTMLElement>('h2');
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

  /** Mark the mobile directory link that the shell focus manager should restore. */
  private markDirectoryFocusTarget(): void {
    const path = this.currentSection() ?? this.lastFocusedSection;
    if (!path) {
      return;
    }
    this.clearRouteFocusTargets();
    const link = this.nav()?.nativeElement.querySelector<HTMLElement>(
      `[data-testid="settings-nav-${path}"]`,
    );
    if (link) {
      link.dataset['routeFocus'] = '';
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
