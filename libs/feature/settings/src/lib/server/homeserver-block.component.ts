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
import { TrnBadge } from '@trinity/components/generic-content';
import { TrnSettingsRowComponent } from '@trinity/components/overlay';
import { HomeserverInfoService } from '@trinity/data-access/homeserver';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { TrustAccountStatusService } from '@trinity/data-access/trust';
import { runWithBusy } from '@trinity/util/ui';

/**
 * What one account's homeserver is running, as a block in the Server section.
 *
 * Loads on first render and reads {@link HomeserverInfoService}'s per-session cache afterwards,
 * so switching sections does not re-probe. There is no refresh here: the section header owns
 * one for every account.
 *
 * **Every remote row degrades to "Unknown" rather than to an error.** The service resolves a
 * null-object instead of throwing, so `runWithBusy`'s error branch is unreachable; it is wired
 * so a future failing service does not fail silently (its spec asserts the branch stays dead).
 */
@Component({
  selector: 'trn-homeserver-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './homeserver-block.component.html',
  host: { class: 'block' },
  imports: [TrnSettingsRowComponent, TrnBadge],
})
export class HomeserverBlockComponent implements OnInit {
  private readonly homeservers = inject(HomeserverInfoService);
  private readonly identities = inject(AccountIdentitiesService);
  private readonly accountTrust = inject(TrustAccountStatusService);
  private readonly destroyRef = inject(DestroyRef);

  readonly userId = input.required<string>();

  /**
   * A remote value in a row's control column. Long ones (a version with a build tag, a
   * homeserver URL with no spaces) wrap rather than widen the page.
   */
  protected readonly valueClass =
    'block max-w-64 text-end [overflow-wrap:anywhere] max-sm:max-w-none max-sm:text-start';

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** This account's name for the block heading, falling back to its mxid. */
  protected readonly displayName = computed(
    () => this.identities.identityOf(this.userId()).displayName,
  );

  /** This account's trust summary, or null before Trust has read it. */
  protected readonly trust = computed(
    () => this.accountTrust.summaries().get(this.userId()) ?? null,
  );

  /** This account's device here is unverified (its identity exists, the device is not signed). */
  protected readonly unverified = computed(() => this.trust() === 'unverified');

  /** The block's name, which says "unverified" as its heading does. */
  protected readonly regionLabel = computed(
    () =>
      `Homeserver for ${this.displayName()}${this.unverified() ? ', unverified' : ''}`,
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
   * What the block's live region says. One string that CHANGES, rather than text inserted
   * with its region, which is what makes the answer announced at all.
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
