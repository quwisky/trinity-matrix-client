import { render } from '@trinity/testing';
import { MessageReplyPreviewComponent } from './message-reply-preview.component';

describe('MessageReplyPreviewComponent', () => {
  const reply = {
    id: '$reply',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: 'earlier message',
    shield: null,
  };

  it('renders the referenced sender and body', async () => {
    const { container } = await render(MessageReplyPreviewComponent, {
      inputs: { reply },
    });

    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('earlier message');
    expect(container.querySelector('button')).toHaveAttribute(
      'aria-label',
      'Replying to Alice',
    );
  });

  it('shows no mark, and names none, when the quote is not marked', async () => {
    const { container } = await render(MessageReplyPreviewComponent, {
      inputs: { reply },
    });

    expect(container.querySelector('trn-unencrypted-mark')).toBeNull();
  });

  it('shows the not-encrypted mark and names it when the quote is marked', async () => {
    const { container } = await render(MessageReplyPreviewComponent, {
      inputs: {
        reply: {
          ...reply,
          shield: {
            level: 'unencrypted',
            reason: 'Not encrypted',
            explanation: 'Sent without encryption.',
          },
        },
      },
    });

    expect(
      container.querySelector('[data-testid="unencrypted-mark-unencrypted"]'),
    ).toBeInTheDocument();
    expect(container.querySelector('button')).toHaveAttribute(
      'aria-label',
      'Replying to Alice, not encrypted message',
    );
  });

  it('emits the referenced event id when opened', async () => {
    const { container, fixture } = await render(MessageReplyPreviewComponent, {
      inputs: { reply },
    });
    const jumped = vi.fn();
    fixture.componentInstance.jump.subscribe(jumped);

    container.querySelector('button')?.click();

    expect(jumped).toHaveBeenCalledWith('$reply');
  });
});
