import { Injectable, Injector, Signal, computed, inject } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  catchError,
  concat,
  debounceTime,
  distinctUntilChanged,
  map,
  of,
  switchMap,
} from 'rxjs';
import { IdentityService } from '@trinity/data-access/identity';
import { RoomLibrarySearchService } from '@trinity/data-access/room-library';
import { UserDirectoryDiscoveryService } from '@trinity/data-access/discovery';
import type { WorkspaceSearchIntent } from '@trinity/application/workspace';
import { initialOf } from '@trinity/util/matrix';

const PEOPLE_DEBOUNCE_MS = 250;
const MIN_REMOTE_QUERY_LENGTH = 2;

export type SwitcherKind = 'room' | 'space' | 'dm' | 'invite' | 'user';

interface SwitcherResultBase {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly avatarMxc: string | null;
  readonly initial: string;
  readonly score: number;
  readonly encrypted?: boolean;
  /** Exact Account on which Workspace must resolve this result. */
  readonly accountId: string;
  /** Present only when the mixed-account UI should identify the owning Account. */
  readonly accountBadgeId?: string;
}

/** Typed row consumed by global-search surfaces such as the Quick Switcher. */
export type SwitcherResult =
  | (SwitcherResultBase & {
      readonly kind: 'invite';
      readonly isDirect: boolean;
      readonly isSpace: boolean;
    })
  | (SwitcherResultBase & {
      readonly kind: Exclude<SwitcherKind, 'invite'>;
      readonly isDirect?: never;
    });

/** A Workspace destination emitted after a global-search row is selected. */
/** Transitional surface name retained for dialog callers. */
export type SwitcherSelection = WorkspaceSearchIntent;

export type GlobalSearchGroup =
  | {
      readonly kind: 'local';
      readonly status: 'ready';
      readonly results: readonly SwitcherResult[];
    }
  | {
      readonly kind: 'people';
      readonly status: 'idle' | 'loading';
      readonly results: readonly SwitcherResult[];
      readonly limited: false;
    }
  | {
      readonly kind: 'people';
      readonly status: 'ready';
      readonly results: readonly SwitcherResult[];
      /** The homeserver truncated results; its API exposes no continuation token. */
      readonly limited: boolean;
    }
  | {
      readonly kind: 'people';
      readonly status: 'failed';
      readonly results: readonly SwitcherResult[];
      readonly limited: false;
      readonly failure: GlobalSearchFailure;
    };

export interface GlobalSearchFailure {
  readonly source: 'people';
  readonly message: string;
  readonly retryable: true;
}

export interface GlobalSearchSession {
  readonly groups: Signal<readonly GlobalSearchGroup[]>;
  readonly results: Signal<readonly SwitcherResult[]>;
  readonly searching: Signal<boolean>;
  readonly failure: Signal<GlobalSearchFailure | null>;
}

/**
 * Application-level Global Search orchestration. It composes Room Library's live local
 * index with Discovery's cold remote lookup, owning debounce, cancellation, loading,
 * truncation, and safe failures without importing a Matrix SDK adapter.
 */
@Injectable({ providedIn: 'root' })
export class GlobalSearchService {
  private readonly local = inject(RoomLibrarySearchService);
  private readonly people = inject(UserDirectoryDiscoveryService);
  private readonly identity = inject(IdentityService);

  createSession(
    query: Signal<string>,
    activeAccountOnly: Signal<boolean>,
    injector: Injector,
  ): GlobalSearchSession {
    const localResults = computed<readonly SwitcherResult[]>(() =>
      this.local.search(
        query(),
        undefined,
        activeAccountOnly()
          ? (this.identity.activeUserId() ?? undefined)
          : undefined,
      ),
    );

    const peopleGroup = toSignal(
      toObservable(query, { injector }).pipe(
        map((value) => value.trim()),
        debounceTime(PEOPLE_DEBOUNCE_MS),
        distinctUntilChanged(),
        switchMap((term) => {
          const accountId = this.identity.activeUserId();
          if (term.length < MIN_REMOTE_QUERY_LENGTH || !accountId) {
            return of<GlobalSearchGroup>({
              kind: 'people',
              status: 'idle',
              results: [],
              limited: false,
            });
          }
          return concat(
            of<GlobalSearchGroup>({
              kind: 'people',
              status: 'loading',
              results: [],
              limited: false,
            }),
            this.people.search(term).pipe(
              map((page): GlobalSearchGroup => ({
                kind: 'people',
                status: 'ready',
                results: page.users.map((user) => ({
                  kind: 'user',
                  id: user.userId,
                  title: user.displayName,
                  subtitle: user.userId,
                  avatarMxc: user.avatarMxc,
                  initial: initialOf(user.displayName),
                  score: 0,
                  accountId,
                })),
                limited: page.limited,
              })),
              catchError(() =>
                of<GlobalSearchGroup>({
                  kind: 'people',
                  status: 'failed',
                  results: [],
                  limited: false,
                  failure: {
                    source: 'people',
                    message: 'People search is temporarily unavailable.',
                    retryable: true,
                  },
                }),
              ),
            ),
          );
        }),
      ),
      {
        injector,
        initialValue: {
          kind: 'people',
          status: 'idle',
          results: [],
          limited: false,
        } satisfies GlobalSearchGroup,
      },
    );

    const groups = computed<readonly GlobalSearchGroup[]>(() => [
      { kind: 'local', status: 'ready', results: localResults() },
      peopleGroup(),
    ]);
    const results = computed<readonly SwitcherResult[]>(() =>
      groups().flatMap((group) => group.results),
    );
    const searching = computed(() => peopleGroup().status === 'loading');
    const failure = computed(() => {
      const group = peopleGroup();
      return group.status === 'failed' ? group.failure : null;
    });

    return { groups, results, searching, failure };
  }

  destinationFor(result: SwitcherResult): WorkspaceSearchIntent {
    switch (result.kind) {
      case 'room':
      case 'dm':
        return {
          kind: 'conversation',
          accountId: result.accountId,
          roomId: result.id,
        };
      case 'space':
        return {
          kind: 'space',
          accountId: result.accountId,
          spaceId: result.id,
        };
      case 'user':
        return {
          kind: 'person',
          accountId: result.accountId,
          userId: result.id,
        };
      case 'invite':
        return {
          kind: 'invitation',
          accountId: result.accountId,
          roomId: result.id,
          target: result.isSpace
            ? 'space'
            : result.isDirect
              ? 'direct'
              : 'conversation',
        };
      default:
        return this.unreachableResult(result);
    }
  }

  private unreachableResult(result: never): never {
    throw new Error(`Unsupported global-search result: ${String(result)}`);
  }
}
