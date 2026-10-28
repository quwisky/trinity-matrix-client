import {
  Injectable,
  type Signal,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  BehaviorSubject,
  type Observable,
  defer,
  firstValueFrom,
  from,
} from 'rxjs';
import {
  projectActiveAccount,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { EngineRequestError, type EngineResult } from '@trinity/util/matrix';
import { EXPRESSION_ENGINE } from './expression-engine.token';
import {
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  type ImagePackUsage,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
} from './image-pack.service';
import {
  ImagePackSelectionStore,
  type PackSources,
  packSources,
  selectedRoomIds,
} from './image-pack-selection.store';
import {
  ImagePackManagementError,
  type ImagePackDiscovery,
  type ImagePackSource,
  type ImagePackUsageSource,
  type ManagedImagePack,
  hasImagePackReference,
  inspectStatePacks,
  mutateSelectionContent,
  mutateSelectionEnabledUsage,
  readManagedImagePacks,
  validateImagePackSource,
} from './image-pack-management.model';

export * from './image-pack-management.model';

const VERIFY_ATTEMPTS = 3;

type ImagePackMutation =
  | { readonly kind: 'install' }
  | { readonly kind: 'uninstall' }
  | {
      readonly kind: 'usage';
      readonly source: ImagePackUsageSource;
      readonly enabled: readonly ImagePackUsage[];
    };

const SELECTION_TYPES = [
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
];

/** Installs and removes MSC2545 account pack references without authoring room state. */
@Injectable({ providedIn: 'root' })
export class ImagePackManagementService {
  private readonly engine = inject(EXPRESSION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly selections = inject(ImagePackSelectionStore);
  private readonly installedState = signal<readonly ManagedImagePack[]>([]);
  private readonly queues = new Map<string, Promise<void>>();
  /** Re-reads the sources for a confirmed selection. */
  private readonly refresh = new BehaviorSubject<void>(undefined);
  private consumers = 0;

  readonly installed: Signal<readonly ManagedImagePack[]> =
    this.installedState.asReadonly();

  private readonly projection = projectActiveAccount<PackSources>({
    id: 'media.image-pack-management',
    subscribe: (accountId) =>
      packSources(
        this.engine,
        this.selections,
        accountId,
        SELECTION_TYPES,
        this.refresh,
      ),
    rebuild: ({ data, rooms }, accountId) => {
      this.installedState.set(
        readManagedImagePacks(
          data,
          rooms,
          untracked(() => this.selections.get(accountId)),
        ),
      );
    },
    reset: () => this.installedState.set([]),
  });

  constructor() {
    effect(() => {
      const accountId = this.session.activeAccountId();
      if (accountId) this.selections.get(accountId);
      untracked(() => this.refresh.next());
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
    return defer(() => from(this.discoverFor(this.accountId(), source)));
  }

  /** Add one exact room/state-key reference to stable account data. Cold. */
  install(source: ImagePackSource): Observable<void> {
    return defer(() =>
      from(this.mutate(this.accountId(), source, { kind: 'install' })),
    );
  }

  /** Remove only the account reference; room membership, state, and media remain. Cold. */
  uninstall(source: ImagePackSource): Observable<void> {
    return defer(() =>
      from(this.mutate(this.accountId(), source, { kind: 'uninstall' })),
    );
  }

  /** Change which publisher-supported usages Trinity exposes. Cold. */
  setEnabledUsage(
    source: ImagePackUsageSource,
    enabled: readonly ImagePackUsage[],
  ): Observable<void> {
    return defer(() =>
      from(
        this.mutate(this.accountId(), source, {
          kind: 'usage',
          source,
          enabled,
        }),
      ),
    );
  }

  private accountId(): string {
    const accountId = untracked(this.session.activeAccountId);
    if (!accountId) throw new ImagePackManagementError('not-signed-in');
    return accountId;
  }

  private async discoverFor(
    accountId: string,
    source: string,
  ): Promise<ImagePackDiscovery> {
    const normalized = validateImagePackSource(source);
    const joined = await settled(
      this.engine.joinPackRoom(accountId, normalized),
    );
    const roomName = boundedRoomName(joined.roomName);
    const packs = inspectStatePacks(
      joined.roomId,
      roomName,
      joined.events,
    ).filter((pack) => pack.status === 'available' || pack.status === 'empty');
    if (packs.length === 0) {
      throw new ImagePackManagementError('no-packs');
    }
    return { roomId: joined.roomId, roomName, packs };
  }

  private mutate(
    accountId: string,
    source: ImagePackSource,
    mutation: ImagePackMutation,
  ): Promise<void> {
    const previous = this.queues.get(accountId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.mutateSerialized(accountId, source, mutation));
    this.queues.set(accountId, operation);
    const cleanup = (): void => {
      if (this.queues.get(accountId) === operation) {
        this.queues.delete(accountId);
      }
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private async mutateSerialized(
    accountId: string,
    source: ImagePackSource,
    mutation: ImagePackMutation,
  ): Promise<void> {
    // Account data has no compare-and-set, so each attempt merges into the server's copy (past
    // the local store, which may miss another device's recent write) and reads it back.
    const fetch = (type: string) =>
      settled(this.engine.fetchAccountData(accountId, type));
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      const stable = await fetch(IMAGE_PACK_ROOMS_EVENT_TYPE);
      const base =
        stable === null
          ? await fetch(LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE)
          : stable;
      if (
        mutation.kind === 'usage' &&
        !hasImagePackReference(base, source, stable === null)
      ) {
        continue;
      }
      const next =
        mutation.kind === 'usage'
          ? mutateSelectionEnabledUsage(
              base,
              mutation.source,
              mutation.enabled,
              stable === null,
            )
          : mutateSelectionContent(
              base,
              source,
              mutation.kind === 'install',
              stable === null,
            );
      // Null-prototype maps keep keys such as `__proto__`; the engine writes them raw.
      await settled(
        this.engine.setAccountData(
          accountId,
          IMAGE_PACK_ROOMS_EVENT_TYPE,
          next,
        ),
      );
      const verified = await fetch(IMAGE_PACK_ROOMS_EVENT_TYPE);
      if (verified !== null && sameJsonDocument(verified, next)) {
        const selection = { present: true, content: verified };
        this.selections.set(accountId, selection);
        const rooms = await firstValueFrom(
          this.engine.packRooms(accountId, selectedRoomIds(verified)),
        );
        // Shown at once, ahead of the sync echo, unless another account has become active.
        if (untracked(this.session.activeAccountId) === accountId) {
          this.installedState.set(readManagedImagePacks({}, rooms, selection));
        }
        return;
      }
    }
    throw new ImagePackManagementError('write-conflict');
  }
}

/** A command's value; its failure rejects, as `not-signed-in` while the account has no running client. */
async function settled<T>(command: Observable<EngineResult<T>>): Promise<T> {
  const result = await firstValueFrom(command);
  if (result.ok) return result.value;
  if (result.failure.code === 'account-not-live') {
    throw new ImagePackManagementError('not-signed-in');
  }
  throw new EngineRequestError(result.failure);
}

function sameJsonDocument(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonDocument(value, right[index]))
    );
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJsonDocument(left[key], right[key]),
    )
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedRoomName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 256) : null;
}
