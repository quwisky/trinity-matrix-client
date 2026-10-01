import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { type PollView } from '@trinity/util/matrix';
import { PollComponent } from './poll.component';

function poll(over: Partial<PollView> = {}): PollView {
  return {
    id: '$p',
    question: 'Best fruit?',
    ended: false,
    totalVotes: 3,
    maxSelections: 1,
    options: [
      { id: 'a0', text: 'Apple', votes: 2, chosen: false },
      { id: 'a1', text: 'Pear', votes: 1, chosen: true },
    ],
    ...over,
  };
}

describe('PollComponent', () => {
  it('accepts the immutable poll projection exposed by Conversations', async () => {
    const immutable = Object.freeze({
      ...poll(),
      options: Object.freeze(
        poll().options.map((option) => Object.freeze({ ...option })),
      ),
    });

    const { container } = await render(PollComponent, {
      inputs: { poll: immutable },
    });

    expect(container.textContent).toContain('Best fruit?');
  });

  it('renders the question, options, counts, and total', async () => {
    const { container } = await render(PollComponent, {
      inputs: { poll: poll() },
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Best fruit?');
    expect(text).toContain('Apple');
    expect(text).toContain('Pear');
    expect(text).toContain('3 votes');
    // Apple: 2/3 = 67%, Pear: 1/3 = 33%.
    expect(text).toContain('2 (67%)');
    expect(text).toContain('1 (33%)');
  });

  it('emits a vote for the clicked option', async () => {
    const { fixture, container } = await render(PollComponent, {
      inputs: { poll: poll() },
    });
    let voted: readonly string[] | undefined;
    fixture.componentInstance.vote.subscribe((ids) => (voted = ids));

    container.querySelectorAll<HTMLButtonElement>('.poll__option')[0].click();

    expect(voted).toEqual(['a0']); // single-select replaces the current choice
  });

  describe('multi-select', () => {
    const multi = (chosen: boolean[]) =>
      poll({
        maxSelections: 2,
        options: ['Apple', 'Pear', 'Plum'].map((text, i) => ({
          id: `a${i}`,
          text,
          votes: 0,
          chosen: chosen[i],
        })),
      });

    async function clickOption(view: PollView, index: number) {
      const { fixture, container } = await render(PollComponent, {
        inputs: { poll: view },
      });
      let voted: readonly string[] | undefined;
      fixture.componentInstance.vote.subscribe((ids) => (voted = ids));
      container
        .querySelectorAll<HTMLButtonElement>('.poll__option')
        [index].click();
      return { voted, container };
    }

    it('adds a clicked option to the current choices', async () => {
      const { voted } = await clickOption(multi([true, false, false]), 1);
      expect(voted).toEqual(['a0', 'a1']);
    });

    it('removes a chosen option when clicked again', async () => {
      const { voted } = await clickOption(multi([true, true, false]), 0);
      expect(voted).toEqual(['a1']);
    });

    it('disables unchosen options once the limit is reached', async () => {
      const { voted, container } = await clickOption(
        multi([true, true, false]),
        2,
      );
      const buttons =
        container.querySelectorAll<HTMLButtonElement>('.poll__option');
      expect(buttons[2].disabled).toBe(true);
      expect(buttons[0].disabled).toBe(false);
      expect(voted).toBeUndefined();
    });

    it('tells the voter how many answers they may choose', async () => {
      const { container } = await clickOption(multi([false, false, false]), 0);
      expect(container.textContent).toContain('Choose up to 2');
    });
  });

  it('disables voting and shows final results once ended', async () => {
    const { fixture, container } = await render(PollComponent, {
      inputs: { poll: poll({ ended: true }) },
    });
    let voted = false;
    fixture.componentInstance.vote.subscribe(() => (voted = true));

    const option = container.querySelector<HTMLButtonElement>('.poll__option')!;
    expect(option.disabled).toBe(true);
    option.click();
    expect(voted).toBe(false);
    expect(container.textContent).toContain('Final results');
  });

  it('offers "End poll" to the creator only while open, and emits end', async () => {
    const { fixture, container } = await render(PollComponent, {
      inputs: { poll: poll(), canEnd: true },
    });
    let ended = false;
    fixture.componentInstance.end.subscribe(() => (ended = true));

    const endBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid=poll-end]',
    );
    expect(endBtn).toBeTruthy();
    endBtn?.click();
    expect(ended).toBe(true);
  });

  it('keeps voting and ending inert while the poll itself is still being sent', async () => {
    // Until the remote echo lands, `poll.id` is the SDK's `~roomId:txnId` local-echo
    // placeholder; relating a vote (or an end) to it makes matrix-js-sdk throw, so the
    // controls must not fire at all.
    const { fixture, container } = await render(PollComponent, {
      inputs: { poll: poll(), canEnd: true, pending: true },
    });
    let voted = false;
    let ended = false;
    fixture.componentInstance.vote.subscribe(() => (voted = true));
    fixture.componentInstance.end.subscribe(() => (ended = true));

    const option = container.querySelector<HTMLButtonElement>('.poll__option')!;
    const endBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid=poll-end]',
    )!;
    expect(option.disabled).toBe(true);
    expect(endBtn.disabled).toBe(true);
    option.click();
    endBtn.click();
    expect(voted).toBe(false);
    expect(ended).toBe(false);
  });

  it('hides "End poll" when the poll has ended', async () => {
    const { container } = await render(PollComponent, {
      inputs: { poll: poll({ ended: true }), canEnd: true },
    });
    expect(container.querySelector('[data-testid=poll-end]')).toBeNull();
  });
});
