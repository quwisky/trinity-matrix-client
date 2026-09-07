import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnLabel } from '@trinity/components/controls';
import { TrnDialogService } from '@trinity/components/overlay';
import { DEFAULT_PUSH_GATEWAY_URL } from '@trinity/util/push-client';
import {
  PushGatewayService,
  PushService,
  normalizeGatewayUrl,
} from '@trinity/data-access/notifications';
import {
  PushGatewayTrustDialogComponent,
  type PushGatewayTrustData,
} from './push-gateway-trust-dialog.component';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading/settings-section-heading.component';
import {
  EMPTY,
  defer,
  catchError,
  filter,
  map,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';

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

  /** Safe local failures, such as storage or durable cleanup failures. */
  readonly recoveryError = signal<string | null>(null);
  readonly hasRecoveryError = computed(
    () => this.recoveryError() !== null || this.errorMessage() !== null,
  );

  /** Draft URL (committed on Save), including the build default when applicable. */
  readonly urlDraft = signal(this.gateway.effective()?.gatewayUrl ?? '');
  readonly placeholderGateway = computed(
    () => this.gateway.effective()?.gatewayUrl === DEFAULT_PUSH_GATEWAY_URL,
  );

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

  /** A configured gateway can be disabled, including the build default. */
  readonly canClear = computed(() => this.gateway.effective() !== null);

  /** Save is offered when the draft is valid and differs from what is stored. */
  readonly canSave = computed(() => {
    const check = this.check();
    if (!check?.ok) {
      return false;
    }
    return check.url !== this.gateway.effective()?.gatewayUrl;
  });

  onUrlInput(event: Event): void {
    this.urlDraft.set((event.target as HTMLInputElement).value);
  }

  /** Confirm the trust implications, persist the gateway, and (re)register pushers. */
  save(): void {
    const check = this.check();
    if (!check?.ok) {
      return;
    }
    this.recoveryError.set(null);
    this.confirmTrust$(check.url, check.insecure)
      .pipe(
        filter(Boolean),
        tap(() => this.urlDraft.set(check.url)),
        switchMap(() =>
          defer(() => this.gateway.save(check.url)).pipe(
            catchError(() => {
              this.recoveryError.set(GATEWAY_RECOVERY_MESSAGE);
              return EMPTY;
            }),
          ),
        ),
        // register() re-applies pushers for every account against the new config, does the
        // app-id swap if one is needed, and drives the `registration` signal the status line
        // reads — so the outcome surfaces through the service signal.
        switchMap(() => this.push.register()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: () => this.recoveryError.set(GATEWAY_RECOVERY_MESSAGE),
      });
  }

  /**
   * Turn the gateway off. Persist the disabled choice before cleanup so a failed cleanup
   * leaves push disabled and the applied ledger available for the next retry.
   */
  clear(): void {
    this.recoveryError.set(null);
    defer(() => this.gateway.clear())
      .pipe(
        switchMap(() => this.push.unregister()),
        tap(() => {
          this.urlDraft.set('');
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: () => this.recoveryError.set(GATEWAY_RECOVERY_MESSAGE),
      });
  }

  /** Retry either durable cleanup after Clear or the failed registration round. */
  retry(): void {
    this.recoveryError.set(null);
    this.push
      .retryRegistration()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => this.recoveryError.set(GATEWAY_RECOVERY_MESSAGE),
      });
  }

  private confirmTrust$(url: string, insecure: boolean): Observable<boolean> {
    const data: PushGatewayTrustData = { url, insecure };
    return this.dialog
      .openAndWait$<boolean>(PushGatewayTrustDialogComponent, {
        inputs: { data },
        ariaLabel: 'Trust this push gateway?',
      })
      .pipe(map((confirmed) => confirmed ?? false));
  }
}

const GATEWAY_RECOVERY_MESSAGE =
  'Push gateway changes could not be completed. Try again.';

/** Blocking-problem code → the message shown under the field. */
const PROBLEM_TEXT: Record<string, string> = {
  'too-long': 'That URL is too long.',
  malformed: 'Enter a full URL, like https://push.example.org.',
  'unsupported-scheme': 'The address must start with https:// or http://.',
  'embedded-credentials': 'Remove the username and password from the URL.',
  'wrong-path':
    'A gateway must be reached at /_matrix/push/v1/notify — remove any other path.',
};
