import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { HlmButton } from '@trinity/helm/button';

/** What the confirmation needs to describe the gateway the user is about to trust. */
export interface PushGatewayTrustData {
  /** The normalised gateway URL. */
  readonly url: string;
  /** True when the scheme is `http:` — an unencrypted metadata path to warn about. */
  readonly insecure: boolean;
}

/**
 * Trust confirmation for saving a custom push gateway.
 *
 * A dedicated dialog rather than the generic `TrnAlertService.confirm()`, which renders
 * its message as a single paragraph: the honest disclosure here is a *list* of what the
 * operator can see, and the http case adds a distinct warning. Making the user trust a
 * gateway is the one genuinely dangerous step of the feature — someone talked into
 * pasting a "faster relay" hands its operator a persistent metadata feed keyed to their
 * real Matrix id — so the copy names exactly what leaks and what does not.
 */
@Component({
  selector: 'trn-push-gateway-trust-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './push-gateway-trust-dialog.component.html',
  imports: [HlmButton],
})
export class PushGatewayTrustDialogComponent {
  private readonly dialogRef = inject<DialogRef<boolean>>(DialogRef);
  readonly data = inject<PushGatewayTrustData>(DIALOG_DATA);

  /** Host shown in the prose (the URL is already normalised, so this cannot throw). */
  readonly host = computed(() => {
    try {
      return new URL(this.data.url).host;
    } catch {
      return this.data.url;
    }
  });

  confirm(): void {
    this.dialogRef.close(true);
  }

  cancel(): void {
    this.dialogRef.close(false);
  }
}
