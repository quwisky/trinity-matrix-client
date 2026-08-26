import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
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
import { HlmButton } from '@trinity/helm/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import { PageHeaderComponent } from '@trinity/components/page-header';
import { BUILD_INFO } from '@trinity/platform-native';
import { MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { TrnIconComponent, type TrnIconName } from '@trinity/components/icon';

/** One row of the settings submenu, routing to its section sub-page. */
interface SettingsMenuItem {
  readonly path: string;
  readonly label: string;
  readonly icon: TrnIconName;
}

const MENU: readonly SettingsMenuItem[] = [
  { path: 'profile', label: 'Profile', icon: 'user' },
  { path: 'presence', label: 'Presence', icon: 'circle-dot' },
  { path: 'appearance', label: 'Appearance', icon: 'palette' },
  { path: 'devices', label: 'Devices', icon: 'monitor-smartphone' },
  { path: 'account', label: 'Account', icon: 'key-round' },
  { path: 'security', label: 'Security', icon: 'lock' },
  { path: 'notifications', label: 'Notifications', icon: 'bell' },
  { path: 'server', label: 'Server', icon: 'server' },
  { path: 'privacy', label: 'Privacy', icon: 'shield' },
  { path: 'gifs', label: 'GIFs', icon: 'image' },
  { path: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard' },
  { path: 'experimental', label: 'Experimental', icon: 'flask-conical' },
  { path: 'advanced', label: 'Advanced', icon: 'braces' },
];

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
  // The page sits on the app's content surface, matching the rooms main pane and thread
  // panels; painting the host covers the transparent header + panes (else it falls back to
  // the darker shell background, which is wrong in dark mode). Its panes own scrolling, so
  // clip their overflow at the shell: without this a framed Electron viewport can include
  // descendant overflow in the document and paint a second scrollbar beside the detail pane.
  host: {
    class: 'flex h-full flex-col overflow-hidden bg-[var(--trinity-chat)]',
  },
  imports: [
    PageHeaderComponent,
    TrnIconComponent,
    HlmButton,
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

  readonly menu = MENU;

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
    // The wide two-pane layout must never show an empty detail pane: land the bare
    // `/settings` index on the first section. Narrow leaves the index on the list.
    effect(() => {
      if (this.wide() && !this.sectionActive()) {
        void this.router.navigate([MENU[0].path], {
          relativeTo: this.route,
          replaceUrl: true,
        });
      }
    });
  }

  /**
   * Header back/up. On the narrow single-pane layout the category list is hidden
   * while a section is open, so this is the only route back to it — go up to the
   * index explicitly (history may not hold it after a deep-link or reload). Otherwise
   * (the list itself, or the desktop two-pane) step out of settings through history.
   */
  goBack(): void {
    if (!this.wide() && this.sectionActive()) {
      // Up to the list, replacing the section so a later Back doesn't retrace into it.
      void this.router.navigate(['/settings'], { replaceUrl: true });
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
