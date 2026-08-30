import { Injectable, computed, inject, signal } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import {
  IdentityMatrixPort,
  type ActiveIdentityMatrix,
} from '@trinity/data-access/matrix-client';
import { AvatarService } from '@trinity/data-access/media';
import {
  identityNotReady,
  recoverIdentityOperation,
  type IdentityOperation,
} from './identity-operation-error';

/** The signed-in user's profile. The avatar is the raw `mxc://`; the UI resolves
 * it (authenticated) via the shared avatar resolver. */
export interface IdentityProfile {
  readonly userId: string;
  readonly displayName: string;
  /** Raw `mxc://` avatar, or null when unset. */
  readonly avatarMxc: string | null;
}

/** Safe presentation data for any user; displayName always has an MXID fallback. */
export interface IdentitySummary {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarMxc: string | null;
}

/**
 * Reads and updates the current user's Matrix profile (display name + avatar),
 * wrapping the SDK so components never touch matrix-js-sdk directly. Exposes the
 * profile as a signal that edits patch optimistically.
 */
@Injectable({ providedIn: 'root' })
export class IdentityService {
  private readonly matrix = inject(IdentityMatrixPort);
  private readonly avatars = inject(AvatarService);

  private readonly _profile = signal<IdentityProfile | null>(null);
  readonly activeUserId = this.matrix.activeAccountId;
  /** Never expose one Account's profile after the Active Account has changed. */
  readonly profile = computed(() => {
    const profile = this._profile();
    return profile?.userId === this.activeUserId() ? profile : null;
  });

  /** Fetch the signed-in user's profile from the homeserver. */
  load(): Observable<IdentityProfile> {
    return defer(() => {
      const { accountId: userId, client } = this.active('load-own-profile');
      return from(client.getProfileInfo(userId)).pipe(
        map((info) =>
          this.buildProfile(userId, info.displayname, info.avatar_url ?? null),
        ),
        // A brand-new account has no profile yet (the homeserver 404s); treat
        // that as an empty profile so the editor still renders and can set one.
        catchError((err) =>
          isNotFound(err)
            ? of(this.buildProfile(userId, undefined, null))
            : throwError(() => err),
        ),
        tap((profile) => {
          if (this.matrix.activeAccountId() === userId) {
            this._profile.set(profile);
          }
        }),
      );
    }).pipe(recoverIdentityOperation('load-own-profile'));
  }

  /**
   * Fetch any user's public profile from the homeserver (for a user info card). Unlike
   * {@link load} this is for an arbitrary user and does not touch the signed-in
   * {@link profile} signal. A user with no profile resolves to an empty one.
   */
  lookup(userId: string): Observable<IdentitySummary> {
    return defer(() => {
      const { client } = this.active('lookup-user');
      return from(client.getProfileInfo(userId)).pipe(
        map((info) =>
          this.buildSummary(userId, info.displayname, info.avatar_url ?? null),
        ),
        catchError((err) =>
          isNotFound(err)
            ? of(this.buildSummary(userId, undefined, null))
            : throwError(() => err),
        ),
      );
    }).pipe(recoverIdentityOperation('lookup-user'));
  }

  /** Search the homeserver user directory independently of Room membership. */
  search(term: string): Observable<readonly IdentitySummary[]> {
    const trimmed = term.trim();
    if (!trimmed) {
      return of([]);
    }
    return defer(() =>
      from(
        this.active('search-users').client.searchUserDirectory({
          term: trimmed,
        }),
      ),
    ).pipe(
      map((response) =>
        response.results.map((user) =>
          this.buildSummary(
            user.user_id,
            user.display_name,
            user.avatar_url ?? null,
          ),
        ),
      ),
      recoverIdentityOperation('search-users'),
    );
  }

  /** Set the display name (an empty name renders as the user id). */
  setDisplayName(name: string): Observable<void> {
    const trimmed = name.trim();
    return defer(() => {
      const context = this.active('set-display-name');
      return from(context.client.setDisplayName(trimmed)).pipe(
        tap(() => this.patch(context.accountId, { displayName: trimmed })),
        map(() => void 0),
      );
    }).pipe(recoverIdentityOperation('set-display-name'));
  }

  /** Upload a picked image to the media repo and set it as the avatar. */
  setAvatar(file: File): Observable<void> {
    return defer(() => {
      const context = this.active('set-avatar');
      return this.avatars.upload(file, context.accountId).pipe(
        switchMap((res) =>
          from(context.client.setAvatarUrl(res)).pipe(map(() => res)),
        ),
        tap((mxc) => this.patch(context.accountId, { avatarMxc: mxc })),
        map(() => void 0),
      );
    }).pipe(recoverIdentityOperation('set-avatar'));
  }

  private buildProfile(
    userId: string,
    displayname: string | undefined,
    avatarMxc: string | null,
  ): IdentityProfile {
    return {
      // Raw display name ('' when unset) — callers render `displayName || userId`.
      // Keeping it raw lets the name editor show an empty field for a nameless
      // user and lets clearing the name settle correctly.
      userId,
      displayName: displayname ?? '',
      avatarMxc,
    };
  }

  private buildSummary(
    userId: string,
    displayName: string | undefined,
    avatarMxc: string | null,
  ): IdentitySummary {
    return {
      userId,
      displayName: displayName || userId,
      avatarMxc,
    };
  }

  private patch(accountId: string, partial: Partial<IdentityProfile>): void {
    const current = this._profile();
    if (
      current?.userId === accountId &&
      this.matrix.activeAccountId() === accountId
    ) {
      this._profile.set({ ...current, ...partial });
    }
  }

  private active(operation: IdentityOperation): ActiveIdentityMatrix {
    if (!this.matrix.isAvailable()) {
      throw identityNotReady(operation);
    }
    const context = this.matrix.active();
    if (!context.accountId) {
      throw identityNotReady(operation);
    }
    return context;
  }
}

/** Whether a getProfileInfo rejection means "no profile yet" (vs a real error). */
function isNotFound(err: unknown): boolean {
  const e = err as { httpStatus?: number; errcode?: string };
  return e?.httpStatus === 404 || e?.errcode === 'M_NOT_FOUND';
}
