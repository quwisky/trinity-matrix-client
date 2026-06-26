import { Component, inject, signal } from '@angular/core';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
  IonText,
} from '@ionic/angular/standalone';
import { CryptoSpikeService, CryptoSpikeResult } from '@trinity/core';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonText],
})
export class HomePage {
  private readonly spike = inject(CryptoSpikeService);

  readonly running = signal(false);
  readonly result = signal<CryptoSpikeResult | null>(null);

  async runSpike(): Promise<void> {
    this.running.set(true);
    this.result.set(null);
    this.result.set(await this.spike.run());
    this.running.set(false);
  }
}
