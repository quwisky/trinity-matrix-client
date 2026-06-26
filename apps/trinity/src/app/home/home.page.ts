import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
  IonText,
} from '@ionic/angular/standalone';
import { finalize } from 'rxjs';
import { CryptoSpikeService, CryptoSpikeResult } from '@trinity/core';

@Component({
  selector: 'trn-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonText],
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
