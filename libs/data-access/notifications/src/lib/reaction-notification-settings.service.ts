import { Injectable, Signal, inject, signal } from '@angular/core';
import { ClientEvent, type MatrixClient } from 'matrix-js-sdk';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { Observable, defer, from, map, throwError } from 'rxjs';

export const REACTION_NOTIFICATION_EVENT =
  'eu.qwky.trinity.reaction_notifications';

const DEFAULT_ON = false;

@Injectable({ providedIn: 'root' })
export class ReactionNotificationSettingsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly _enabled = signal(DEFAULT_ON);
  private boundClient: MatrixClient | null = null;

  readonly enabled: Signal<boolean> = this._enabled.asReadonly();

  private readonly onAccountData = (): void => {
    const client = this.boundClient;
    if (client) {
      this._enabled.set(this.readClient(client));
    }
  };

  private readonly projection = projectFromClient({
    id: 'notifications.reaction-settings',
    matrix: this.matrix,
    rebuild: (client) => this._enabled.set(this.readClient(client)),
    bind: (client) => {
      this.boundClient = client;
      client.on(ClientEvent.AccountData, this.onAccountData);
    },
    unbind: (client) => {
      client.off(ClientEvent.AccountData, this.onAccountData);
      if (this.boundClient === client) {
        this.boundClient = null;
      }
    },
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
    const content = client
      .getAccountData?.(REACTION_NOTIFICATION_EVENT as never)
      ?.getContent?.() as { enabled?: unknown } | undefined;
    return typeof content?.enabled === 'boolean' ? content.enabled : DEFAULT_ON;
  }
}
