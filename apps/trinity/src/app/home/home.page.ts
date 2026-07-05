import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import { PageHeaderComponent } from '@trinity/ui';
import {
  CryptoSpikeResult,
  CryptoSpikeService,
} from '@trinity/data-access-crypto';

@Component({
  selector: 'trn-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [HlmButton, PageHeaderComponent],
})
export class HomePage {
  private readonly spike = inject(CryptoSpikeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly running = signal(false);
  readonly result = signal<CryptoSpikeResult | null>(null);

  runSpike(): void {
    this.running.set(true);
    this.result.set(null);
    this.spike
      .run()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.running.set(false)),
      )
      .subscribe((result) => this.result.set(result));
  }
}
