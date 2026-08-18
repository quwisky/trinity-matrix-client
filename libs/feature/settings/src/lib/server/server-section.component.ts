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
import { runWithBusy } from '@trinity/util/ui';
import { HomeserverBlockComponent } from './homeserver-block.component';

/**
 * Server section: one block per signed-in account, saying what that account's homeserver is
 * running. The client's own build line is not repeated here — the settings shell renders it
 * in the footer of every section, so both halves are already on screen together.
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
  imports: [HlmButton, HomeserverBlockComponent],
})
export class ServerSectionComponent {
  private readonly matrix = inject(MatrixClientService);
  private readonly homeservers = inject(HomeserverInfoService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly accounts = this.matrix.accountIds;
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
