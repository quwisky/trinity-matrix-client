import { Injectable, inject, type Signal } from '@angular/core';
import {
  ClientEvent,
  UserEvent,
  type EmittedEvents,
  type MatrixClient,
} from 'matrix-js-sdk';
import type { Observable } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';
import { projectFromClient } from './project-from-client';

/** SDK event spellings kept at the Matrix adapter boundary. */
export const IDENTITY_MATRIX_EVENTS = {
  avatarUrl: UserEvent.AvatarUrl,
  displayName: UserEvent.DisplayName,
  presence: UserEvent.Presence,
  sync: ClientEvent.Sync,
} as const;

/** User fields Identity may project from the SDK store; Room membership is not included. */
export interface IdentitySdkUser {
  readonly userId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string | null;
  readonly presence?: string;
  readonly presenceStatusMsg?: string;
}

/** Protocol operations owned by Identity; Account and sync lifecycle methods are absent. */
export type IdentityMatrixClient = Pick<
  MatrixClient,
  | 'getIgnoredUsers'
  | 'getProfileInfo'
  | 'getUserId'
  | 'isUserIgnored'
  | 'off'
  | 'on'
  | 'setAvatarUrl'
  | 'setDisplayName'
  | 'setIgnoredUsers'
  | 'setPresence'
> & {
  getUser(userId: string): IdentitySdkUser | null;
};

/** One already-started Account captured for a single Identity command. */
export interface ActiveIdentityMatrix {
  readonly accountId: string;
  readonly client: IdentityMatrixClient;
}

export interface IdentityProjectionConfig {
  readonly id: string;
  readonly rebuild?: (client: IdentityMatrixClient) => void;
  readonly events?: readonly EmittedEvents[];
  readonly bind?: (client: IdentityMatrixClient) => void;
  readonly unbind?: (client: IdentityMatrixClient) => void;
  readonly reset?: () => void;
  readonly reprojectOnSwitch?: boolean;
}

export interface IdentityProjection {
  run(): Observable<void>;
  isConnected(): boolean;
  client(): IdentityMatrixClient | null;
  schedule(): void;
}

/** Lifecycle-free Matrix adapter consumed by the Identity capability. */
@Injectable({ providedIn: 'root' })
export class IdentityMatrixPort {
  private readonly matrix = inject(MatrixClientService);

  readonly activeAccountId: Signal<string | null> = this.matrix.activeUserId;
  readonly accountIds: Signal<readonly string[]> = this.matrix.accountIds;

  isAvailable(): boolean {
    return this.matrix.isInitialized;
  }

  active(): ActiveIdentityMatrix {
    const client = this.matrix.instance;
    return {
      accountId: client.getUserId() ?? '',
      client: client as IdentityMatrixClient,
    };
  }

  forAccount(accountId: string): IdentityMatrixClient | null {
    return (
      (this.matrix.clientFor(accountId) as IdentityMatrixClient | null) ?? null
    );
  }

  project(config: IdentityProjectionConfig): IdentityProjection {
    const projection = projectFromClient({
      id: config.id,
      matrix: this.matrix,
      ...(config.events ? { events: config.events } : {}),
      ...(config.rebuild
        ? {
            rebuild: (client: MatrixClient) =>
              config.rebuild?.(client as IdentityMatrixClient),
          }
        : {}),
      ...(config.bind
        ? {
            bind: (client: MatrixClient) =>
              config.bind?.(client as IdentityMatrixClient),
          }
        : {}),
      ...(config.unbind
        ? {
            unbind: (client: MatrixClient) =>
              config.unbind?.(client as IdentityMatrixClient),
          }
        : {}),
      ...(config.reset ? { reset: config.reset } : {}),
      ...(config.reprojectOnSwitch === undefined
        ? {}
        : { reprojectOnSwitch: config.reprojectOnSwitch }),
    });
    return {
      run: () => projection.run(),
      isConnected: () => projection.isConnected(),
      client: () => projection.client() as IdentityMatrixClient | null,
      schedule: () => projection.schedule(),
    };
  }
}
