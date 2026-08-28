import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/button';
import { TrnInput } from '@trinity/components/input';
import { TrnLabel } from '@trinity/components/label';
import { TrnDialogService } from '@trinity/components/overlay';
import {
  PushGatewayService,
  PushService,
  normalizeGatewayUrl,
} from '@trinity/data-access/notifications';
import {
  PushGatewayTrustDialogComponent,
  type PushGatewayTrustData,
} from './push-gateway-trust-dialog.component';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading.component';

/**
 * The push-gateway block inside the Notifications section (device-local; see
 * {@link PushGatewayService}). Lets the user point mobile push at their own gateway,
 * confirm the trust implications, and see whether the pushers registered.
 *
 * Signals rather than a reactive form, to match the sibling `GifsSectionComponent` and
 * because the live validation (normalise the path, warn on http) is naturally a computed
 * over the draft. On web and the Electron shell the whole block is disabled — push has
 * no plugin there and the value is device-local, so a URL typed on desktop could never
 * reach the phone.
 */
@Component({
  selector: 'trn-push-gateway-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './push-gateway-block.component.html',
  imports: [TrnButton, TrnInput, TrnLabel, SettingsSectionHeadingComponent],
})
export class PushGatewayBlockComponent {
  private readonly gateway = inject(PushGatewayService);
  private readonly push = inject(PushService);
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);

  // PushService.registration drives the status line via appliedAccounts/errorMessage.

  /** True on iOS/Android; false on web + Electron, where the block is inert. */
  readonly supported = this.gateway.supported;

  /**
   * Number of accounts the pushers were registered on, once applied, else null. A
   * computed rather than reading the signal in the template, because `@switch` does not
   * narrow the union there.
   */
  readonly appliedAccounts = computed(() => {
    const state = this.push.registration();
    return state.status === 'applied' ? state.accounts : null;
  });

  /** The homeserver's message when the last round failed, else null. */
  readonly errorMessage = computed(() => {
    const state = this.push.registration();
    return state.status === 'error' ? state.message : null;
  });

  /** Draft URL (committed on Save); seeded from the user's stored override. */
  readonly urlDraft = signal(this.gateway.override()?.gatewayUrl ?? '');
  /** Draft base app id — an advanced field for a gateway keyed under another id. */
  readonly appIdDraft = signal(this.gateway.override()?.appId ?? '');
  /** Whether the advanced (app id) field is revealed. */
  readonly advancedOpen = signal(!!this.gateway.override()?.appId);

  /** Live validation of the draft URL (empty draft reads as no error, not an error). */
  private readonly check = computed(() =>
    this.urlDraft().trim() ? normalizeGatewayUrl(this.urlDraft()) : null,
  );

  /** A blocking validation message, or null when the field is empty or valid. */
  readonly errorText = computed(() => {
    const check = this.check();
    if (!check || check.ok) {
      return null;
    }
    return PROBLEM_TEXT[check.problem];
  });

  /** The normalised URL to be saved, shown as a hint when it differs from the input. */
  readonly normalizedHint = computed(() => {
    const check = this.check();
    if (!check?.ok) {
      return null;
    }
    return check.url !== this.urlDraft().trim() ? check.url : null;
  });

  /** True when the valid draft points at an unencrypted `http:` gateway. */
  readonly insecure = computed(() => {
    const check = this.check();
    return check?.ok === true && check.insecure;
  });

  /** A gateway override is currently stored (enables Clear). */
  readonly hasOverride = computed(() => this.gateway.override() !== null);

  /** Save is offered when the draft is valid and differs from what is stored. */
  readonly canSave = computed(() => {
    const check = this.check();
    if (!check?.ok) {
      return false;
    }
    const stored = this.gateway.override();
    const storedAppId = stored?.appId ?? '';
    return (
      check.url !== stored?.gatewayUrl ||
      this.appIdDraft().trim() !== storedAppId
    );
  });

  onUrlInput(event: Event): void {
    this.urlDraft.set((event.target as HTMLInputElement).value);
  }

  onAppIdInput(event: Event): void {
    this.appIdDraft.set((event.target as HTMLInputElement).value);
  }

  toggleAdvanced(): void {
    this.advancedOpen.update((open) => !open);
  }

  /** Confirm the trust implications, persist the gateway, and (re)register pushers. */
  async save(): Promise<void> {
    const check = this.check();
    if (!check?.ok) {
      return;
    }
    const confirmed = await this.confirmTrust(check.url, check.insecure);
    if (!confirmed) {
      return;
    }
    // Reflect the normalisation back into the field so what is stored is visible.
    this.urlDraft.set(check.url);
    const appId = this.appIdDraft().trim() || undefined;
    await this.gateway.save(check.url, appId);
    // register() re-applies pushers for every account against the new config, does the
    // app-id swap if one is needed, and drives the `registration` signal the status line
    // reads — so the outcome surfaces without anything to await here.
    this.push
      .register()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: () => undefined });
  }

  /**
   * Turn the gateway off. Tears the pushers down *before* clearing the stored gateway —
   * `unregister()` reads the applied-app-id ledger to know what to remove, and clearing
   * drops it (see {@link PushService.liveAppIds}).
   */
  clear(): void {
    this.push
      .unregister()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => undefined,
        complete: () => {
          void this.gateway.clear();
          this.urlDraft.set('');
          this.appIdDraft.set('');
          this.advancedOpen.set(false);
        },
      });
  }

  private async confirmTrust(url: string, insecure: boolean): Promise<boolean> {
    const data: PushGatewayTrustData = { url, insecure };
    return (
      (await this.dialog.openAndWait<boolean>(PushGatewayTrustDialogComponent, {
        inputs: { data },
        ariaLabel: 'Trust this push gateway?',
      })) ?? false
    );
  }
}

/** Blocking-problem code → the message shown under the field. */
const PROBLEM_TEXT: Record<string, string> = {
  'too-long': 'That URL is too long.',
  malformed: 'Enter a full URL, like https://push.example.org.',
  'unsupported-scheme': 'The address must start with https:// or http://.',
  'embedded-credentials': 'Remove the username and password from the URL.',
  'wrong-path':
    'A gateway must be reached at /_matrix/push/v1/notify — remove any other path.',
};
