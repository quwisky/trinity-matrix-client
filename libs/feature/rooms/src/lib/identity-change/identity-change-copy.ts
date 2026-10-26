import type { IdentityChange } from './room-identity-changes.service';

/** What changed, as a short status for a list row or the member card. */
export function identityChangeStatus(trust: IdentityChange['trust']): string {
  return trust === 'identity-changed'
    ? 'Identity changed'
    : 'Verified identity changed';
}

/** One person's change, as the banner's sentence. */
export function identityChangeSentence(change: IdentityChange): string {
  return change.trust === 'identity-changed'
    ? `${change.name}'s identity changed.`
    : `${change.name}'s verified identity changed.`;
}
