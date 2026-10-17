import { inject } from '@angular/core';
import { HostAuthenticationHandoffService } from './host-operation.services';

/** The web and mobile name, and the fallback when the desktop shell reports none. */
const DEFAULT_APP_NAME = 'Trinity';

/**
 * The app's own name: "Trinity", or "Trinity Next" in the desktop prerelease; the host names
 * its Matrix devices after it. A shell that reports no identity fails sign-in on its own, so
 * the name falls back rather than break the caller. Call it in an injection context;
 * the name is fixed for the process.
 */
export function injectHostAppName(): string {
  const handoff = inject(HostAuthenticationHandoffService);
  try {
    return handoff.deviceDisplayName() || DEFAULT_APP_NAME;
  } catch {
    return DEFAULT_APP_NAME;
  }
}
