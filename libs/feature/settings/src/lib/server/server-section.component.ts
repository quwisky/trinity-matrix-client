import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import { HomeserverInfoService } from '@trinity/data-access/homeserver';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { BUILD_INFO } from '@trinity/platform-native';
import {
  BELOW_MD_QUERY,
  mediaQuerySignal,
  runWithBusy,
} from '@trinity/util/ui';
import { HomeserverBlockComponent } from './homeserver-block.component';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading.component';

/**
 * Server section: one block per signed-in account, saying what that account's homeserver is
 * running.
 *
 * The client's own build line is repeated here **only on narrow layouts**. The settings shell
 * renders it in the nav footer, which answers #155's "one screen for both versions" on a wide
 * layout — but that nav is hidden below 768px whenever a section is open
 * (`settings.page.scss`), so on a phone the two halves could never be seen together, which is
 * exactly the platform the ask came from. Duplicating it unconditionally would give one fact
 * two sources on the layout where the footer is already visible.
 *
 * A thin host over repeated child blocks, like the notifications section. What is section-
 * level rather than per-block is **Check again**: the value being watched is "did the deploy
 * land?", the answer is one glance, and one button that re-checks everything reads better
 * than a row of identical buttons — which for the single-account case is the same thing.
 *
 * Signed-in means a **live client** (`accountIds()`). Accounts the server soft-logged-out
 * keep a stored record but have no client to ask, and are already surfaced as re-auth rows
 * in the account menu; listing them here with every row unknown would be noise.
 */
@Component({
  selector: 'trn-server-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './server-section.component.html',
  imports: [
    HlmButton,
    HomeserverBlockComponent,
    SettingsSectionHeadingComponent,
  ],
})
export class ServerSectionComponent {
  private readonly matrix = inject(MatrixClientService);
  private readonly homeservers = inject(HomeserverInfoService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly build = inject(BUILD_INFO);

  protected readonly accounts = this.matrix.accountIds;
  /** Only where the shell's own build line is hidden — see the class doc. */
  protected readonly showBuildLine = mediaQuerySignal(
    BELOW_MD_QUERY,
    this.destroyRef,
  );
  protected readonly buildLabel = `Trinity v${this.build.version} · ${this.build.commit}`;
  protected readonly refreshing = signal(false);
  /**
   * Unreachable by construction, like the per-block one: `refreshAll()` resolves rather
   * than throws whatever the servers do, which its own spec asserts. Wired and rendered
   * anyway so that a service which starts failing later says so rather than leaving the
   * button to spin and stop with nothing changed.
   */
  protected readonly refreshError = signal<string | null>(null);

  /**
   * Re-probe every account, ignoring the per-session cache.
   *
   * The blocks render from the service's signal, so nothing is passed down: each one
   * updates as its own answer lands rather than all of them at the end.
   */
  protected checkAgain(): void {
    runWithBusy(this.homeservers.refreshAll(), {
      busy: this.refreshing,
      error: this.refreshError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }
}
