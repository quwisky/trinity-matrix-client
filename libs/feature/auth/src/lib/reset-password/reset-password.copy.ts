import type { ResetRefused } from '@trinity/data-access/auth';

export const RESET_PASSWORD_COPY = {
  title: 'Reset your password',
  subtitle: 'Reset the password for your Matrix account',
  noServer: 'Choose your server on the sign-in page first',
  emailBody: 'Enter the email address on your account.',
  emailLabel: 'Email address',
  emailRequired: 'Enter your email address.',
  emailInvalid: 'Enter a valid email address.',
  sendLink: 'Send link',
  sentTitle: 'Check your email',
  passwordTitle: 'Choose a new password',
  sent: (email: string) =>
    `We sent a link to ${email}. Open it and confirm, then come back here.`,
  continue: 'Continue',
  resend: 'Resend link',
  passwordLabel: 'New password',
  passwordRequired: 'Choose a new password.',
  confirmLabel: 'Confirm new password',
  confirmRequired: 'Confirm your new password.',
  mismatch: 'Passwords do not match.',
  logoutDevices: 'Sign out of all devices',
  logoutDevicesNote:
    'Devices without a backup of your encryption keys lose access to encrypted messages.',
  submit: 'Reset password',
  backToSignIn: 'Back to sign in',
  working: 'Working…',
  wait: (seconds: number) => `Try again in ${seconds}s`,
} as const;

/** Why a step was refused, in plain words. */
export function refusalMessage(refused: ResetRefused, seconds: number): string {
  switch (refused.refusal) {
    case 'unknown-address':
      return 'Trinity couldn’t send a link to that address. Check it, or use the address on your account.';
    case 'invalid-address':
      return 'That doesn’t look like a valid email address.';
    case 'not-confirmed':
      return 'Confirm the link in the email first, then try again.';
    case 'weak-password':
      return (
        refused.reason ?? 'That password is too weak. Choose a stronger one.'
      );
    case 'rate-limited':
      return seconds > 0
        ? `Too many tries. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`
        : 'Too many tries. Try again shortly.';
    case 'unreachable':
      return 'Trinity couldn’t reach your server. Check your connection and try again.';
    case 'failed':
      return 'Something went wrong. Try again.';
  }
}
