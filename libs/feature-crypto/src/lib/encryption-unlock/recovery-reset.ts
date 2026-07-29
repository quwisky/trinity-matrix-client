/**
 * The MSC2965 account-management action for resetting cross-signing.
 *
 * Hand-rolled: matrix-js-sdk 41.x types `account_management_actions_supported` as a bare
 * `string[]` and ships no enum for its members — `cross_signing_reset` appears nowhere in
 * the SDK. If one is added later, this constant is the single place to swap.
 */
export const CROSS_SIGNING_RESET_ACTION = 'org.matrix.cross_signing_reset';

/** The word the user has to type before an irreversible reset will run. */
export const RESET_CONFIRMATION_WORD = 'RESET';

/**
 * What the user is agreeing to, cost first.
 *
 * Written out here rather than inline so the wording is reviewed as prose and cannot
 * drift between the surfaces that offer the reset. Each line is a consequence the user
 * cannot discover afterwards, and the order is deliberate: what is destroyed, what is
 * disrupted, what they get back.
 */
export const RESET_CONSEQUENCES = [
  'Your message backup on the server is deleted. Messages your devices cannot already read stay unreadable — forever.',
  'Your other devices lose their verified status and must be verified again. They stay signed in.',
  'You get a new recovery key. Save it.',
].join('\n\n');

/**
 * The provider's account-management page, deep-linked to the cross-signing reset when the
 * provider says it supports that action.
 *
 * Returns null when it does not: sending someone to a generic account page that cannot do
 * the thing they came for is worse than telling them plainly that their provider has to.
 */
export function crossSigningResetUrl(management: {
  url: string;
  actionsSupported: string[];
}): string | null {
  if (!management.actionsSupported.includes(CROSS_SIGNING_RESET_ACTION)) {
    return null;
  }
  try {
    const url = new URL(management.url);
    url.searchParams.set('action', CROSS_SIGNING_RESET_ACTION);
    return url.toString();
  } catch {
    // The value comes from homeserver-controlled metadata and is only checked for an
    // `https:` prefix upstream — which `https://` alone satisfies while still throwing
    // here. An unusable URL is the same answer as an unadvertised action: no deep link.
    return null;
  }
}
