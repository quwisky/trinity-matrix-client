import { describe, expect, it, vi } from 'vitest';
import type { TrnAlertService } from '@trinity/helm/overlay';
import {
  CLEAR_DATA_CONFIRMATION_WORD,
  CLEAR_DATA_CONSEQUENCES,
  clearDataMessage,
  confirmClearDataIntent,
  signedInWarning,
} from './clear-all-data';

const alertWith = (typed: string | null) =>
  ({ prompt: vi.fn().mockResolvedValue(typed) }) as unknown as TrnAlertService;

describe('clear-all-data copy', () => {
  it('asks for ERASE', () => {
    // That it must DIFFER from the encryption-reset flow's word is a cross-library
    // invariant — feature libs may not import each other — so it is asserted in
    // scripts/confirmation-words.spec.mjs, which can read both modules.
    expect(CLEAR_DATA_CONFIRMATION_WORD).toBe('ERASE');
  });

  it('leads with the permanent loss and ends with what survives', () => {
    const paragraphs = CLEAR_DATA_CONSEQUENCES.split('\n\n');

    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toMatch(/permanently unreadable/i);
    // Someone doing this while panicking needs to know their conversations are not deleted.
    expect(paragraphs[2]).toMatch(/Nothing on the server is deleted/i);
  });

  it('never claims to sign the user out everywhere', () => {
    // The server call is best-effort behind a short budget and may not happen at all — this
    // button's whole reason for existing is that the homeserver may be unreachable.
    const message = clearDataMessage(['@a:hs']);

    expect(message).not.toMatch(/everywhere/i);
    expect(message).toMatch(/may still be listed on your homeserver/i);
  });

  it('names every signed-in account, because /login?add is reachable while they are live', () => {
    expect(signedInWarning(['@a:hs', '@b:hs'])).toContain('@a:hs');
    expect(signedInWarning(['@a:hs', '@b:hs'])).toContain('@b:hs');
    expect(signedInWarning(['@a:hs', '@b:hs'])).toMatch(/2 accounts/);
    expect(signedInWarning(['@a:hs'])).toMatch(/This account is signed in/);
  });

  it('says nothing about accounts when none are signed in', () => {
    // The common wedged case — cannot sign in at all. A warning about "0 accounts" would
    // be noise on the one path where the reset is least frightening.
    expect(signedInWarning([])).toBe('');
    expect(clearDataMessage([])).not.toMatch(/signed in on this device/);
  });

  it('always asks for the word', () => {
    expect(clearDataMessage([])).toMatch(/Type ERASE to confirm/);
    expect(clearDataMessage(['@a:hs'])).toMatch(/Type ERASE to confirm/);
  });
});

describe('confirmClearDataIntent', () => {
  it('accepts the word regardless of case or surrounding space', async () => {
    await expect(
      confirmClearDataIntent(alertWith('  erase '), []),
    ).resolves.toBe('confirmed');
  });

  it('treats the OTHER flow’s word as a mistype, not a confirmation', async () => {
    await expect(confirmClearDataIntent(alertWith('RESET'), [])).resolves.toBe(
      'mistyped',
    );
  });

  it('distinguishes cancelling from mistyping', async () => {
    // They mean different things to the user: one needs an explanation, the other needs
    // silence. Collapsing them would either nag someone who changed their mind or leave
    // someone who fat-fingered it staring at a button that appears broken.
    await expect(confirmClearDataIntent(alertWith(null), [])).resolves.toBe(
      'cancelled',
    );
    await expect(confirmClearDataIntent(alertWith(''), [])).resolves.toBe(
      'mistyped',
    );
  });

  it('asks destructively, with the accounts named in the body', async () => {
    const alert = alertWith('ERASE');

    await confirmClearDataIntent(alert, ['@a:hs']);

    expect(alert.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Erase all Trinity data',
        destructive: true,
        confirmText: 'Erase everything',
        message: expect.stringContaining('@a:hs'),
      }),
    );
  });
});
