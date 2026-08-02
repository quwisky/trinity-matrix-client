import { Injectable, inject, signal } from '@angular/core';
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
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/** The signed-in user's profile. The avatar is the raw `mxc://`; the UI resolves
 * it (authenticated) via the shared avatar resolver. */
export interface UserProfile {
  userId: string;
  displayName: string;
  /** Raw `mxc://` avatar, or null when unset. */
  avatarMxc: string | null;
}

/**
 * Reads and updates the current user's Matrix profile (display name + avatar),
 * wrapping the SDK so components never touch matrix-js-sdk directly. Exposes the
 * profile as a signal that edits patch optimistically.
 */
@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _profile = signal<UserProfile | null>(null);
  readonly profile = this._profile.asReadonly();

  /** Fetch the signed-in user's profile from the homeserver. */
  load(): Observable<UserProfile> {
    return defer(() => {
      const client = this.matrix.instance;
      const userId = client.getUserId() ?? '';
      return from(client.getProfileInfo(userId)).pipe(
        map((info) =>
          this.build(userId, info.displayname, info.avatar_url ?? null),
        ),
        // A brand-new account has no profile yet (the homeserver 404s); treat
        // that as an empty profile so the editor still renders and can set one.
        catchError((err) =>
          isNotFound(err)
            ? of(this.build(userId, undefined, null))
            : throwError(() => err),
        ),
        tap((profile) => this._profile.set(profile)),
      );
    });
  }

  /**
   * Fetch any user's public profile from the homeserver (for a user info card). Unlike
   * {@link load} this is for an arbitrary user and does not touch the signed-in
   * {@link profile} signal. A user with no profile resolves to an empty one.
   */
  fetch(userId: string): Observable<UserProfile> {
    return defer(() =>
      from(this.matrix.instance.getProfileInfo(userId)).pipe(
        map((info) =>
          this.build(userId, info.displayname, info.avatar_url ?? null),
        ),
        catchError((err) =>
          isNotFound(err)
            ? of(this.build(userId, undefined, null))
            : throwError(() => err),
        ),
      ),
    );
  }

  /** Set the display name (an empty name renders as the user id). */
  setDisplayName(name: string): Observable<void> {
    const trimmed = name.trim();
    return defer(() => from(this.matrix.instance.setDisplayName(trimmed))).pipe(
      tap(() => this.patch({ displayName: trimmed })),
      map(() => void 0),
    );
  }

  /** Upload a picked image to the media repo and set it as the avatar. */
  setAvatar(file: File): Observable<void> {
    return defer(() => {
      const client = this.matrix.instance;
      return from(
        client.uploadContent(file, {
          name: file.name,
          type: file.type || 'application/octet-stream',
        }),
      ).pipe(
        switchMap((res) =>
          from(client.setAvatarUrl(res.content_uri)).pipe(
            map(() => res.content_uri),
          ),
        ),
        tap((mxc) => this.patch({ avatarMxc: mxc })),
        map(() => void 0),
      );
    });
  }

  private build(
    userId: string,
    displayname: string | undefined,
    avatarMxc: string | null,
  ): UserProfile {
    return {
      // Raw display name ('' when unset) — callers render `displayName || userId`.
      // Keeping it raw lets the name editor show an empty field for a nameless
      // user and lets clearing the name settle correctly.
      userId,
      displayName: displayname ?? '',
      avatarMxc,
    };
  }

  private patch(partial: Partial<UserProfile>): void {
    const current = this._profile();
    if (current) {
      this._profile.set({ ...current, ...partial });
    }
  }
}

/** Whether a getProfileInfo rejection means "no profile yet" (vs a real error). */
function isNotFound(err: unknown): boolean {
  const e = err as { httpStatus?: number; errcode?: string };
  return e?.httpStatus === 404 || e?.errcode === 'M_NOT_FOUND';
}
