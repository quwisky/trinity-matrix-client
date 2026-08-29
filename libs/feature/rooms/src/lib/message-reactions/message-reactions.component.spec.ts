import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { type ReactionView } from '@trinity/data-access/timeline';
import { MessageReactionsComponent } from './message-reactions.component';

function reaction(over: Partial<ReactionView> = {}): ReactionView {
  return { key: '👍', count: 1, reacted: false, reactors: ['Alice'], ...over };
}

describe('MessageReactionsComponent', () => {
  it('renders a pill per reaction, flags the user’s own, and emits toggle', async () => {
    const { container, fixture } = await render(MessageReactionsComponent, {
      inputs: {
        reactions: [
          reaction({ key: '👍', count: 2, reacted: true, reactors: ['You'] }),
          reaction({ key: '❤️', count: 1 }),
        ],
      },
    });

    const pills = container.querySelectorAll<HTMLButtonElement>(
      '.reaction:not(.reaction--who)',
    );
    expect(pills.length).toBe(2);
    expect(container.querySelectorAll('.reaction--mine').length).toBe(1);
    expect(pills[0].textContent).toContain('👍');
    expect(pills[0].textContent).toContain('2');

    let toggled = '';
    fixture.componentInstance.toggleReaction.subscribe((k) => (toggled = k));
    pills[0].click();
    expect(toggled).toBe('👍');
  });

  it('names the reactors on each pill, summarising the rest by count', async () => {
    const { container } = await render(MessageReactionsComponent, {
      inputs: {
        reactions: [
          reaction({
            count: 7,
            reacted: true,
            reactors: ['You', 'Alice', 'Bob'],
          }),
          reaction({ key: '🎉', count: 2, reactors: ['Alice', 'Bob'] }),
          reaction({ key: '😮', count: 2, reactors: ['Alice'] }),
        ],
      },
    });

    const labels = [
      ...container.querySelectorAll('.reaction:not(.reaction--who)'),
    ].map((pill) => pill.getAttribute('aria-label'));

    expect(labels[0]).toBe('👍 reacted by You, Alice, Bob and 4 others');
    expect(labels[1]).toBe('🎉 reacted by Alice and Bob');
    // A lone extra reactor is "1 other", not "1 others".
    expect(labels[2]).toBe('😮 reacted by Alice and 1 other');
  });

  it('asks for the whole list from the trailing chip', async () => {
    const { container, fixture } = await render(MessageReactionsComponent, {
      inputs: { reactions: [reaction({ key: '🎉' })] },
    });
    let asked = 0;
    fixture.componentInstance.showReactors.subscribe(() => asked++);

    container
      .querySelector<HTMLButtonElement>('[data-testid=reactions-who]')!
      .click();

    expect(asked).toBe(1);
  });
});
