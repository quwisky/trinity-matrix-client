import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { parseLocationInput } from '@trinity/util/matrix';
import { GeolocationService, type GeoPoint } from '@trinity/platform-native';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { HlmSpinner } from '@trinity/helm/spinner';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { TrnIconComponent } from '@trinity/helm/icon';

/**
 * Desktop location picker: paste a map link or type `lat, lng`. Closes with the
 * resolved {@link GeoPoint} on share, or `null` when cancelled. Presented by
 * {@link LocationShareService} on the desktop shell, where Chromium's
 * `navigator.geolocation` can't resolve without an embedded Google API key. When the
 * shell exposes it, an opt-in button fills the field from an approximate (IP-based)
 * estimate — never invoked automatically. Sends nothing itself.
 */
@Component({
  selector: 'trn-manual-location-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, HlmButton, HlmInput, HlmLabel, HlmSpinner],
  templateUrl: './manual-location-dialog.component.html',
})
export class ManualLocationDialogComponent {
  private readonly dialogRef = inject<DialogRef<GeoPoint | null>>(DialogRef);
  private readonly geo = inject(GeolocationService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly value = signal('');
  /** The parsed coordinates for the current input, or null when it isn't a location. */
  readonly coords = computed(() => parseLocationInput(this.value()));
  /** Whether the desktop shell can estimate an approximate location (gates the button). */
  readonly canLocate = this.geo.supportsApproximate();
  readonly locating = signal(false);
  /** Polite screen-reader announcement for the non-user-initiated approximate fill. */
  readonly status = signal('');

  onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  /** Estimate the approximate location via the shell and fill the field with it. */
  useApproximate(): void {
    if (this.locating()) {
      return;
    }
    this.locating.set(true);
    this.geo
      .approximateFromDesktop()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ lat, lng }) => {
          this.value.set(`${lat}, ${lng}`);
          this.locating.set(false);
          this.status.set(`Approximate location set to ${lat}, ${lng}.`);
        },
        error: (err: unknown) => {
          this.locating.set(false);
          this.toast.show(
            err instanceof Error
              ? err.message
              : 'Couldn’t estimate your location.',
            { duration: 4000, variant: 'destructive' },
          );
        },
      });
  }

  share(): void {
    const point = this.coords();
    if (point) {
      this.dialogRef.close(point);
    }
  }

  cancel(): void {
    this.dialogRef.close(null);
  }
}
