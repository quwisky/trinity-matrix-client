import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import { Observable, defer, map, switchMap, tap } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { AvatarService } from '@trinity/data-access/media';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { IDENTITY_ENGINE } from './identity-engine.token';
import {
  identityNotReady,
  recoverIdentityOperation,
  type IdentityOperation,
} from './identity-operation-error';

/** The signed-in user's profile. The avatar is the raw `mxc://`; the UI resolves it (authenticated). */
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
 * Reads and updates the current user's Matrix profile (display name + avatar) through the
 * identity engine. Exposes the profile as a signal that edits patch optimistically.
 */
@Injectable({ providedIn: 'root' })
export class IdentityService {
  private readonly engine = inject(IDENTITY_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly avatars = inject(AvatarService);

  private readonly _profile = signal<IdentityProfile | null>(null);
  readonly activeUserId = this.session.activeAccountId;
  /** Never expose one Account's profile after the Active Account has changed. */
  readonly profile = computed(() => {
    const profile = this._profile();
    return profile?.userId === this.activeUserId() ? profile : null;
  });

  /** Fetch the signed-in user's profile from the homeserver. */
  load(): Observable<IdentityProfile> {
    return defer(() => {
      const userId = this.active('load-own-profile');
      return this.engine.profile(userId, userId).pipe(
        unwrapEngineResult(),
        map((info) =>
          this.buildProfile(userId, info.displayName, info.avatarMxc),
        ),
        tap((profile) => {
          if (this.activeUserId() === userId) {
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
    return defer(() =>
      this.engine.profile(this.active('lookup-user'), userId),
    ).pipe(
      unwrapEngineResult(),
      map((info) =>
        this.buildSummary(userId, info.displayName, info.avatarMxc),
      ),
      recoverIdentityOperation('lookup-user'),
    );
  }

  /** Set the display name (an empty name renders as the user id). */
  setDisplayName(name: string): Observable<void> {
    const trimmed = name.trim();
    return defer(() => {
      const accountId = this.active('set-display-name');
      return this.engine.setDisplayName(accountId, trimmed).pipe(
        unwrapEngineResult(),
        tap(() => this.patch(accountId, { displayName: trimmed })),
        map(() => void 0),
      );
    }).pipe(recoverIdentityOperation('set-display-name'));
  }

  /** Upload a picked image to the media repo and set it as the avatar. */
  setAvatar(file: File): Observable<void> {
    return defer(() => {
      const accountId = this.active('set-avatar');
      return this.avatars.upload(file, accountId).pipe(
        switchMap((mxc) =>
          this.engine.setAvatar(accountId, mxc).pipe(
            unwrapEngineResult(),
            map(() => mxc),
          ),
        ),
        tap((mxc) => this.patch(accountId, { avatarMxc: mxc })),
        map(() => void 0),
      );
    }).pipe(recoverIdentityOperation('set-avatar'));
  }

  private buildProfile(
    userId: string,
    displayName: string | null,
    avatarMxc: string | null,
  ): IdentityProfile {
    return {
      // Raw display name ('' when unset): callers render `displayName || userId`, and the
      // editor shows an empty field for a nameless user.
      userId,
      displayName: displayName ?? '',
      avatarMxc,
    };
  }

  private buildSummary(
    userId: string,
    displayName: string | null,
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
    if (current?.userId === accountId && this.activeUserId() === accountId) {
      this._profile.set({ ...current, ...partial });
    }
  }

  private active(operation: IdentityOperation): string {
    const accountId = untracked(this.activeUserId);
    if (!accountId) {
      throw identityNotReady(operation);
    }
    return accountId;
  }
}
