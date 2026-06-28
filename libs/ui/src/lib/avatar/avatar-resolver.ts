import { InjectionToken } from '@angular/core';
import { type Observable } from 'rxjs';

/**
 * Resolves an `mxc://` avatar to a displayable URL (e.g. an authenticated blob URL),
 * or null when unset/unresolvable. Returned async so an implementation can fetch.
 */
export type AvatarResolver = (
  mxc: string | null,
  sizePx: number,
) => Observable<string | null>;

/**
 * Optional resolver the app wires to core's avatar service. When absent (ui in
 * isolation / tests, or no `mxc` given) {@link AvatarComponent} just uses its `url`
 * input — keeping `ui` free of any cross-layer dependency.
 */
export const AVATAR_RESOLVER = new InjectionToken<AvatarResolver>(
  'AVATAR_RESOLVER',
);
