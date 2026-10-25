import { describe, expect, it } from 'vitest';
import { ReauthPrompts, type ReauthStep } from './reauth-prompts';

function setup() {
  const shown: ReauthStep[] = [];
  return { prompts: new ReauthPrompts((step) => shown.push(step)), shown };
}

describe('ReauthPrompts', () => {
  it('password shows the step and resolves with the answer', async () => {
    const { prompts, shown } = setup();

    const answer = prompts.password({ rejected: true });

    expect(shown).toEqual([{ kind: 'password', rejected: true }]);
    expect(prompts.answerPassword('secret')).toBe(true);
    await expect(answer).resolves.toBe('secret');
    expect(prompts.answerPassword('again')).toBe(false);
  });

  it('confirmInBrowser shows the step and resolves with the answer', async () => {
    const { prompts, shown } = setup();

    const finished = prompts.confirmInBrowser({
      url: 'https://x/',
      pending: true,
    });

    expect(shown).toEqual([
      { kind: 'browser', url: 'https://x/', pending: true },
    ]);
    expect(prompts.answerBrowser(true)).toBe(true);
    await expect(finished).resolves.toBe(true);
  });

  it('abandon resolves a waiting password prompt with null and a browser prompt with false', async () => {
    const { prompts } = setup();
    const password = prompts.password({ rejected: false });
    const browser = prompts.confirmInBrowser({
      url: 'https://x/',
      pending: false,
    });

    prompts.abandon();

    await expect(password).resolves.toBeNull();
    await expect(browser).resolves.toBe(false);
    expect(prompts.answerBrowser(true)).toBe(false);
  });

  it('answerPassword returns false when nothing waits', () => {
    expect(setup().prompts.answerPassword('secret')).toBe(false);
  });
});
