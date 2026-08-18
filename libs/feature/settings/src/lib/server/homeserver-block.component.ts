import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { HomeserverInfoService } from '@trinity/data-access/homeserver';
import { AccountProfilesService } from '@trinity/data-access/profile';
import { runWithBusy } from '@trinity/util/ui';

/**
 * What one account's homeserver is running, as a block in the Server section.
 *
 * Loads on first render and reads from {@link HomeserverInfoService}'s per-session cache
 * afterwards, so switching sections does not re-probe; {@link HomeserverBlockComponent} has
 * no refresh of its own because the section header owns one for every account at once.
 *
 * **Every remote row degrades to "Unknown" rather than to an error.** The service resolves
 * a null-object instead of throwing, so `runWithBusy`'s error branch here is unreachable —
 * it is wired anyway, because a future service that *can* fail would otherwise fail
 * silently, and its own spec asserts the branch stays dead.
 */
@Component({
  selector: 'trn-homeserver-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './homeserver-block.component.html',
  styleUrl: './homeserver-block.component.scss',
})
export class HomeserverBlockComponent implements OnInit {
  private readonly homeservers = inject(HomeserverInfoService);
  private readonly profiles = inject(AccountProfilesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly userId = input.required<string>();

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** This account's name for the block heading, falling back to its mxid. */
  protected readonly displayName = computed(
    () => this.profiles.profileOf(this.userId()).displayName,
  );

  /** Null until the first probe finishes — which is what the loading line reads. */
  protected readonly info = computed(
    () => this.homeservers.infos().get(this.userId()) ?? null,
  );

  /** `Synapse 1.158.0 (b=…)`, verbatim, or null when neither attempt answered. */
  protected readonly softwareLabel = computed(() => {
    const software = this.info()?.software;
    return software ? `${software.name} ${software.version}` : null;
  });

  /**
   * What the block's live region says. Written as one string that CHANGES rather than as
   * text inserted with its region, which is what makes the answer announced at all.
   */
  protected readonly announcement = computed(() => {
    const name = this.displayName();
    if (!this.info()) {
      return this.loading() ? `Checking ${name}'s server…` : '';
    }
    return `${name}: ${this.softwareLabel() ?? 'server version unknown'}`;
  });

  /**
   * `ngOnInit`, not the constructor: `userId` is a required signal input, and a required
   * input read during construction throws NG0950 — inputs are only set afterwards.
   */
  ngOnInit(): void {
    runWithBusy(this.homeservers.load(this.userId()), {
      busy: this.loading,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe();
  }
}
