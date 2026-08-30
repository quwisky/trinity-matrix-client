import { describe, expect, it } from 'vitest';
import { RESET_CONFIRMATION_WORD, RESET_CONSEQUENCES } from './recovery-reset';

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
