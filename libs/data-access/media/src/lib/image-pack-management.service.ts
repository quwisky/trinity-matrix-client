import { Injectable, type Signal, effect, inject, signal } from '@angular/core';
import { defer, from, type Observable } from 'rxjs';
import {
  ClientEvent,
  MatrixError,
  Method,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import {
  IMAGE_PACK_EVENT_TYPE,
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
} from './image-pack.service';
import { ImagePackSelectionStore } from './image-pack-selection.store';
import {
  ImagePackManagementError,
  type ImagePackDiscovery,
  type ImagePackSource,
  type ManagedImagePack,
  hasImagePackReference,
  inspectStatePacks,
  mutateSelectionContent,
  readManagedImagePacks,
  roomNameFromState,
  validateImagePackSource,
} from './image-pack-management.model';

export * from './image-pack-management.model';

const VERIFY_ATTEMPTS = 3;

/** Installs and removes MSC2545 account pack references without authoring room state. */
@Injectable({ providedIn: 'root' })
export class ImagePackManagementService {
  private readonly matrix = inject(MatrixClientService);
  private readonly selections = inject(ImagePackSelectionStore);
  private readonly installedState = signal<readonly ManagedImagePack[]>([]);
  private readonly queues = new WeakMap<MatrixClient, Promise<void>>();
  private consumers = 0;

  readonly installed: Signal<readonly ManagedImagePack[]> =
    this.installedState.asReadonly();

  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (
      event.getType() === IMAGE_PACK_EVENT_TYPE ||
      event.getType() === LEGACY_IMAGE_PACK_EVENT_TYPE
    ) {
      this.projection.schedule();
    }
  };

  private readonly onAccountData = (event: MatrixEvent): void => {
    if (event.getType() === IMAGE_PACK_ROOMS_EVENT_TYPE) {
      const client = this.projection.client();
      if (client) {
        this.selections.clear(client);
      }
      this.projection.schedule();
    } else if (event.getType() === LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE) {
      this.projection.schedule();
    }
  };

  private readonly projection = projectFromClient({
    matrix: this.matrix,
    bind: (client) => {
      client.on?.(RoomStateEvent.Events, this.onStateEvent);
      client.on?.(RoomEvent.MyMembership, this.projection.schedule);
      client.on?.(ClientEvent.AccountData, this.onAccountData);
    },
    unbind: (client) => {
      client.off?.(RoomStateEvent.Events, this.onStateEvent);
      client.off?.(RoomEvent.MyMembership, this.projection.schedule);
      client.off?.(ClientEvent.AccountData, this.onAccountData);
    },
    rebuild: (client) => {
      this.installedState.set(
        readManagedImagePacks(client, this.selections.get(client)),
      );
    },
    reset: () => this.installedState.set([]),
  });

  constructor() {
    effect(() => {
      this.selections.changed();
      if (this.projection.isConnected()) this.projection.schedule();
    });
  }

  connect(): void {
    this.consumers += 1;
    this.projection.connect();
  }

  disconnect(): void {
    this.consumers = Math.max(0, this.consumers - 1);
    if (this.consumers === 0) this.projection.disconnect();
  }

  /** Resolve and join a pack room, then fetch its authoritative state. Cold. */
  discover(source: string): Observable<ImagePackDiscovery> {
    return defer(() => from(this.discoverWithClient(this.client(), source)));
  }

  /** Add one exact room/state-key reference to stable account data. Cold. */
  install(source: ImagePackSource): Observable<void> {
    return defer(() => from(this.mutate(this.client(), source, true)));
  }

  /** Remove only the account reference; room membership, state, and media remain. Cold. */
  uninstall(source: ImagePackSource): Observable<void> {
    return defer(() => from(this.mutate(this.client(), source, false)));
  }

  private client(): MatrixClient {
    if (!this.matrix.isInitialized) {
      throw new ImagePackManagementError('not-signed-in');
    }
    return this.matrix.instance;
  }

  private async discoverWithClient(
    client: MatrixClient,
    source: string,
  ): Promise<ImagePackDiscovery> {
    const normalized = validateImagePackSource(source);
    let roomId = normalized;
    let viaServers: string[] | undefined;
    if (normalized.startsWith('#')) {
      const resolved = await client.getRoomIdForAlias(normalized);
      roomId = resolved.room_id;
      viaServers = resolved.servers;
    }

    const knownRoom = client.getRoom?.(roomId);
    if (knownRoom?.getMyMembership?.() !== 'join') {
      await client.joinRoom(roomId, { viaServers });
    }
    const state = await client.roomState(roomId);
    const roomName =
      roomNameFromState(state) ??
      boundedRoomName(client.getRoom?.(roomId)?.name);
    const packs = inspectStatePacks(roomId, roomName, state).filter(
      (pack) => pack.status === 'available' || pack.status === 'empty',
    );
    if (packs.length === 0) {
      throw new ImagePackManagementError('no-packs');
    }
    return { roomId, roomName, packs };
  }

  private mutate(
    client: MatrixClient,
    source: ImagePackSource,
    install: boolean,
  ): Promise<void> {
    const previous = this.queues.get(client) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.mutateSerialized(client, source, install));
    this.queues.set(client, operation);
    const cleanup = (): void => {
      if (this.queues.get(client) === operation) this.queues.delete(client);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private async mutateSerialized(
    client: MatrixClient,
    source: ImagePackSource,
    install: boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      const stable = await getAccountDataFromServer(
        client,
        IMAGE_PACK_ROOMS_EVENT_TYPE,
      );
      const base =
        stable === null
          ? await getAccountDataFromServer(
              client,
              LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
            )
          : stable;
      const next = mutateSelectionContent(
        base,
        source,
        install,
        stable === null,
      );
      await setAccountData(client, IMAGE_PACK_ROOMS_EVENT_TYPE, next);
      const verified = await getAccountDataFromServer(
        client,
        IMAGE_PACK_ROOMS_EVENT_TYPE,
      );
      if (
        verified !== null &&
        hasImagePackReference(verified, source) === install
      ) {
        this.selections.set(client, { present: true, content: verified });
        this.installedState.set(
          readManagedImagePacks(client, { present: true, content: verified }),
        );
        return;
      }
    }
    throw new ImagePackManagementError('write-conflict');
  }
}

type AccountDataClient = {
  setAccountData(
    type: string,
    content: Record<string, unknown>,
  ): Promise<unknown>;
};

function accountDataClient(client: MatrixClient): AccountDataClient {
  return client as unknown as AccountDataClient;
}

async function getAccountDataFromServer(
  client: MatrixClient,
  type: string,
): Promise<unknown | null> {
  const userId = client.getUserId();
  if (!userId) throw new ImagePackManagementError('not-signed-in');
  try {
    // The SDK helper serves the local account-data store after initial sync. This
    // explicit request is required before every merge and verification so a
    // recently-arrived write from another device is not silently overwritten.
    return await client.http.authedRequest<unknown>(
      Method.Get,
      `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`,
    );
  } catch (error) {
    if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

async function setAccountData(
  client: MatrixClient,
  type: string,
  content: Record<string, unknown>,
): Promise<void> {
  await accountDataClient(client).setAccountData(type, content);
}

function boundedRoomName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 256) : null;
}
