import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { MessageReactionsComponent } from './message-reactions.component';

describe('MessageReactionsComponent', () => {
  it('renders a pill per reaction, flags the user’s own, and emits toggle', async () => {
    const { container, fixture } = await render(MessageReactionsComponent, {
      inputs: {
        reactions: [
          { key: '👍', count: 2, reacted: true },
          { key: '❤️', count: 1, reacted: false },
        ],
      },
    });

    const pills = container.querySelectorAll<HTMLButtonElement>('.reaction');
    expect(pills.length).toBe(2);
    expect(container.querySelectorAll('.reaction--mine').length).toBe(1);
    expect(pills[0].textContent).toContain('👍');
    expect(pills[0].textContent).toContain('2');

    let toggled = '';
    fixture.componentInstance.toggleReaction.subscribe((k) => (toggled = k));
    pills[0].click();
    expect(toggled).toBe('👍');
  });
});
