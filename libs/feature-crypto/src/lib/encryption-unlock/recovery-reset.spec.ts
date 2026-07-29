import { describe, expect, it } from 'vitest';
import {
  CROSS_SIGNING_RESET_ACTION,
  RESET_CONFIRMATION_WORD,
  RESET_CONSEQUENCES,
  crossSigningResetUrl,
} from './recovery-reset';

const withAction = { actionsSupported: [CROSS_SIGNING_RESET_ACTION] };

describe('crossSigningResetUrl', () => {
  it('deep-links to the reset when the provider advertises it', () => {
    const url = crossSigningResetUrl({
      url: 'https://auth.example/account',
      ...withAction,
    });

    expect(url).toBe(
      `https://auth.example/account?action=${CROSS_SIGNING_RESET_ACTION}`,
    );
  });

  it('keeps query the provider already put there', () => {
    const url = crossSigningResetUrl({
      url: 'https://auth.example/account?tenant=acme',
      ...withAction,
    });

    expect(url).toContain('tenant=acme');
    expect(url).toContain(`action=${CROSS_SIGNING_RESET_ACTION}`);
  });

  it('returns null when the action is not advertised', () => {
    // Sending someone to a generic account page that cannot do the thing they came for
    // is worse than telling them plainly that their provider has to.
    expect(
      crossSigningResetUrl({
        url: 'https://auth.example/account',
        actionsSupported: ['org.matrix.profile'],
      }),
    ).toBeNull();
  });

  it('returns null for an empty action list', () => {
    expect(
      crossSigningResetUrl({
        url: 'https://auth.example/account',
        actionsSupported: [],
      }),
    ).toBeNull();
  });

  it('returns null rather than throwing on an unparseable URL', () => {
    // The value is homeserver-controlled metadata, and upstream only checks that it
    // starts with `https:` — which the string below satisfies while still being unusable.
    // A throw here escapes into an unguarded async handler and shows the user nothing.
    expect(crossSigningResetUrl({ url: 'https://', ...withAction })).toBeNull();
  });

  it('returns null on junk that is not a URL at all', () => {
    expect(
      crossSigningResetUrl({ url: 'not a url', ...withAction }),
    ).toBeNull();
  });
});

describe('reset copy', () => {
  it('states every consequence the user cannot discover afterwards', () => {
    expect(RESET_CONSEQUENCES).toContain('backup on the server is deleted');
    expect(RESET_CONSEQUENCES).toContain('verified again');
    expect(RESET_CONSEQUENCES).toContain('new recovery key');
  });

  it('separates them with blank lines, which the dialog now renders', () => {
    // The alert dialog renders `message` with `whitespace-pre-line` precisely so these
    // read as three separate points. Joined into one run-on sentence they are, in
    // practice, not read at all — and this is the last screen before deletion.
    expect(RESET_CONSEQUENCES.split('\n\n')).toHaveLength(3);
  });

  it('uses a confirmation word that cannot be typed by accident', () => {
    expect(RESET_CONFIRMATION_WORD).toBe('RESET');
  });
});
