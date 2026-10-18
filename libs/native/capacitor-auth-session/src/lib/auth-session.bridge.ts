import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, catchError, defer, from, map, of } from 'rxjs';

/** The name the iOS host registers the plugin under (`jsName`). */
export const AUTH_SESSION_PLUGIN_NAME = 'TrinityAuthSession';

/** The native plugin's one call: resolves with the callback URL once the page redirects to it. */
interface AuthSessionPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{
    url: string;
  }>;
}

const authSession = registerPlugin<AuthSessionPlugin>(AUTH_SESSION_PLUGIN_NAME);

export type AuthSessionOutcome =
  | { readonly kind: 'completed'; readonly url: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable' };

const UNAVAILABLE = { kind: 'unavailable' } as const;

/** Whether this host has the plugin: the iOS app only; Android, the web and Electron have none. */
export function authSessionAvailable(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable(AUTH_SESSION_PLUGIN_NAME)
  );
}

/**
 * Opens `url` in an iOS authentication session (`ASWebAuthenticationSession`), which hands
 * the redirect to `callbackScheme` back to this app alone rather than through the system's
 * URL routing. Cold and finite; an answer off the callback scheme is unavailable.
 */
export function startAuthSession(request: {
  readonly url: string;
  readonly callbackScheme: string;
}): Observable<AuthSessionOutcome> {
  return defer((): Observable<AuthSessionOutcome> => {
    if (!authSessionAvailable()) return of(UNAVAILABLE);
    return from(
      authSession.start({
        url: request.url,
        callbackScheme: request.callbackScheme,
      }),
    ).pipe(
      map((answer: unknown): AuthSessionOutcome => {
        const url =
          typeof answer === 'object' && answer !== null && 'url' in answer
            ? answer.url
            : undefined;
        return typeof url === 'string' &&
          url.startsWith(`${request.callbackScheme}:`)
          ? { kind: 'completed', url }
          : UNAVAILABLE;
      }),
      catchError((error: unknown) =>
        of<AuthSessionOutcome>(
          typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'cancelled'
            ? { kind: 'cancelled' }
            : UNAVAILABLE,
        ),
      ),
    );
  });
}
