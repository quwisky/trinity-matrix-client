import type {
  EmailAddressRefusal,
  IdentityServerRefusal,
} from '@trinity/data-access/contact-addresses';

export const EMAIL_ADDRESSES_COPY = {
  groupDescription: 'Addresses on your account, used to reset your password.',
  providerLine: 'Your email addresses are managed by your identity provider.',
  readOnlyLine: (server: string) =>
    `${server} manages the addresses on this account.`,
  empty: 'No email address yet. Add one so you can reset your password.',
  removeLabel: (address: string) => `Remove ${address}`,
  removeTitle: (address: string) => `Remove ${address}?`,
  removeBody: 'You won’t be able to reset your password with it.',
  addButton: 'Add email address',
  addressTitle: 'Add an email address',
  addressBody: 'We’ll send a link to this address to check that it’s yours.',
  sendLink: 'Send link',
  sentTitle: 'Check your email',
  sentBody: (email: string) =>
    `We sent a link to ${email}. Open it, then select Continue.`,
  notVerified: 'That link hasn’t been opened yet.',
  resend: 'Resend',
  resent: (email: string) => `We sent a new link to ${email}.`,
  added: (email: string) => `${email} was added.`,
  removed: (address: string) => `${address} was removed.`,
  removedStillFindable: (address: string, host: string) =>
    `${address} was removed. ${host} may still let people find you by it.`,
  identityServerLabel: 'Identity server',
  identityServerOff: 'Off',
  identityServerNone: 'None',
  identityServerDescription:
    'Lets people who know one of your email addresses find you on Matrix.',
  changeButton: 'Change',
  turnOffButton: 'Turn off',
  turnOffAriaLabel: 'Turn off identity server',
  changeServerTitle: 'Change identity server',
  changeServerQuestion: 'Change identity server?',
  serverFieldLabel: 'Identity server address',
  useServer: 'Use this server',
  notHttps: 'Use an address that starts with https://.',
  notIdentityServer:
    'Trinity couldn’t find an identity server at that address.',
  turnOffTitle: 'Turn off the identity server?',
  turnOffBody:
    'Nobody will be able to find you by email until you choose one again.',
  unpublishBody: (host: string, count: number) =>
    `Trinity will first stop ${host} from finding you by ${count} ${count === 1 ? 'address' : 'addresses'}.`,
  serverUnreachable: (host: string) =>
    `Trinity couldn’t reach ${host}. Try again later.`,
  saveFailed: (server: string) =>
    `Trinity couldn’t save that change on ${server}. Try again.`,
  loadFailed: (server: string) =>
    `Trinity couldn’t load your email addresses from ${server}.`,
  findableLabel: 'Findable',
  findableAriaLabel: (email: string) => `Let people find you by ${email}`,
  termsTitle: (host: string) => `Accept ${host}’s terms`,
  termsBody: (host: string) =>
    `To let people find you by email, ${host} needs you to accept:`,
  termsAccept: 'Accept',
  termsDecline: 'Not now',
  publishBody: (host: string, email: string) =>
    `${host} sent a link to ${email}. Open it, then select Continue.`,
  publishSending: 'Sending the link…',
  published: (email: string) => `People who know ${email} can now find you.`,
  unpublished: (email: string) => `People can no longer find you by ${email}.`,
  stoppedTitle: 'The address wasn’t added',
  passwordTitle: 'Enter your password',
  passwordBody: (accountId: string) =>
    `Enter the password for ${accountId} to add this address.`,
  passwordRejected: 'That password is incorrect. The address wasn’t added.',
  submitLabel: 'Add address',
  browserTitle: 'Confirm in your browser',
  browserBody: (server: string) =>
    `${server} needs you to confirm this in your browser. When you have finished, come back here.`,
  browserPending: (server: string) =>
    `${server} hasn’t received your confirmation yet. Finish it in your browser, then try again.`,
  doneLabel: 'I’ve confirmed, add address',
  invalid: 'Enter a valid email address.',
  workingTitle: 'Adding the address…',
} as const;

/** Why an email step stopped, in plain words. */
export function refusalMessage(
  reason: EmailAddressRefusal,
  server: string,
  retryAfterMs?: number,
): string {
  switch (reason) {
    case 'in-use':
      return 'That address is already used by another account.';
    case 'cannot-send':
      return `${server} can’t send email right now.`;
    case 'invalid':
      return EMAIL_ADDRESSES_COPY.invalid;
    case 'rate-limited': {
      const seconds =
        retryAfterMs === undefined ? null : Math.ceil(retryAfterMs / 1000);
      return seconds === null
        ? 'Too many tries. Try again shortly.'
        : `Too many tries. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
    }
    case 'unreachable':
      return `Trinity couldn’t reach ${server}. Check your connection and try again.`;
    case 'attempts-exceeded':
      return 'Too many incorrect passwords. The address wasn’t added.';
    case 'no-usable-stage':
      return `${server} needs a confirmation step Trinity can’t complete. Add the address from another Matrix app, or ask the server’s administrator. The address wasn’t added.`;
    case 'not-verified':
      return EMAIL_ADDRESSES_COPY.notVerified;
    case 'cancelled':
    case 'account-unavailable':
    case 'failed':
      return 'Something went wrong. Try again.';
  }
}

/** Why an identity server refused, in plain words. */
export function identityRefusalMessage(
  reason: IdentityServerRefusal,
  host: string,
  retryAfterMs?: number,
): string {
  switch (reason) {
    case 'unreachable':
      return EMAIL_ADDRESSES_COPY.serverUnreachable(host);
    case 'rate-limited':
      return refusalMessage('rate-limited', host, retryAfterMs);
    default:
      return refusalMessage('failed', host);
  }
}

/** The host part of an identity server URL, for display. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
