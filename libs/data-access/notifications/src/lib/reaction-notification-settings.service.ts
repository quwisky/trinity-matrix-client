import { Injectable, Signal, inject, signal } from '@angular/core';
import { ClientEvent, type MatrixClient } from 'matrix-js-sdk';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { migratedAccountDataContent } from './legacy-account-data';

export const REACTION_NOTIFICATION_EVENT =
  'dev.trinityproject.trinity.reaction_notifications';
/** Retired name; read while only it exists; `NotificationService` copies it to {@link REACTION_NOTIFICATION_EVENT}. */
export const LEGACY_REACTION_NOTIFICATION_EVENT =
  'eu.qwky.trinity.reaction_notifications';

const DEFAULT_ON = false;

@Injectable({ providedIn: 'root' })
export class ReactionNotificationSettingsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly _enabled = signal(DEFAULT_ON);

  readonly enabled: Signal<boolean> = this._enabled.asReadonly();

  private readonly onAccountData = (): void => this._enabled.set(this.isOn());

  private readonly projection = projectFromClient({
    id: 'notifications.reaction-settings',
    matrix: this.matrix,
    rebuild: (client) => this._enabled.set(this.readClient(client)),
    bind: (client) => client.on(ClientEvent.AccountData, this.onAccountData),
    unbind: (client) => client.off(ClientEvent.AccountData, this.onAccountData),
    reset: () => this._enabled.set(DEFAULT_ON),
  });

  connect(): void {
    this.projection.connect();
  }

  disconnect(): void {
    this.projection.disconnect();
  }

  isOn(accountId?: string): boolean {
    if (!this.matrix.isInitialized) {
      return DEFAULT_ON;
    }
    const client = accountId
      ? this.matrix.clientFor(accountId)
      : this.matrix.instance;
    return client ? this.readClient(client) : DEFAULT_ON;
  }

  setOn(on: boolean): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      // Capture the owning client when subscribed. The active account can change before
      // an asynchronous account-data write completes.
      const client = this.matrix.instance;
      return from(
        client.setAccountData(
          REACTION_NOTIFICATION_EVENT as never,
          { enabled: on } as never,
        ),
      ).pipe(
        map(() => {
          if (this.matrix.instance === client) {
            this._enabled.set(on);
          }
        }),
      );
    });
  }

  private readClient(client: MatrixClient): boolean {
    const content = migratedAccountDataContent(
      client as never,
      REACTION_NOTIFICATION_EVENT,
      LEGACY_REACTION_NOTIFICATION_EVENT,
    ) as { enabled?: unknown } | undefined;
    return typeof content?.enabled === 'boolean' ? content.enabled : DEFAULT_ON;
  }
}
