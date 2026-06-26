import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonText,
} from '@ionic/angular/standalone';
import { MatrixClientService } from '../../core/matrix/matrix-client.service';
import { AuthService } from '../../core/matrix/auth.service';

/**
 * Placeholder authenticated landing for Milestone 2. Confirms the session is live
 * (user id + sync state) and offers logout. The real room list arrives in Milestone 4.
 */
@Component({
  selector: 'app-rooms',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Rooms</ion-title>
        <ion-buttons slot="end">
          <ion-button [disabled]="busy()" (click)="logout()">Logout</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <p>Signed in as <strong>{{ userId() }}</strong></p>
      <p><ion-text color="medium">Sync state: {{ matrix.syncState() ?? 'starting…' }}</ion-text></p>
    </ion-content>
  `,
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonText,
  ],
})
export class RoomsPage {
  readonly matrix = inject(MatrixClientService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly busy = signal(false);
  readonly userId = signal(this.matrix.isInitialized ? this.matrix.instance.getUserId() : null);

  async logout(): Promise<void> {
    this.busy.set(true);
    await this.auth.logout();
    await this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}
