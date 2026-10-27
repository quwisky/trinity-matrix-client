import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { HomeserverInfoService } from '@trinity/data-access/homeserver';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { BUILD_INFO } from '@trinity/platform-native';
import {
  BELOW_MD_QUERY,
  mediaQuerySignal,
  runWithBusy,
} from '@trinity/util/ui';
import { HomeserverBlockComponent } from './homeserver-block.component';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
} from '@trinity/components/overlay';

/**
 * Server section: one block per signed-in account, saying what that account's homeserver is
 * running.
 *
 * The client's own build line is repeated here **only on narrow layouts**: the shell shows it
 * in the nav footer, but that nav is hidden below 768px whenever a section is open
 * (`settings.page.scss`). Duplicating it unconditionally would give one fact two sources where
 * the footer is visible.
 *
 * **Check again** is section-level: one button re-checks every account.
 *
 * Signed-in means a **live client** (`accountIds()`). Soft-logged-out accounts have no client
 * to ask and are already surfaced as re-auth rows in the account menu.
 */
@Component({
  selector: 'trn-server-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './server-section.component.html',
  imports: [
    TrnSettingsRowComponent,
    TrnSettingsGroupComponent,
    TrnButton,
    HomeserverBlockComponent,
  ],
})
export class ServerSectionComponent {
  private readonly matrix = inject(SessionStateService);
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
   * Unreachable by construction, like the per-block one: `refreshAll()` resolves rather than
   * throws (its spec asserts this). Wired anyway so a service that starts failing says so.
   */
  protected readonly refreshError = signal<string | null>(null);

  /**
   * Re-probe every account, ignoring the per-session cache. Each block updates as its own
   * answer lands, since it renders from the service's signal.
   */
  protected checkAgain(): void {
    runWithBusy(this.homeservers.refreshAll(), {
      busy: this.refreshing,
      error: this.refreshError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }
}
