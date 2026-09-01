import { render } from '@trinity/testing';
import { MessageReplyPreviewComponent } from './message-reply-preview.component';

describe('MessageReplyPreviewComponent', () => {
  const reply = {
    id: '$reply',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: 'earlier message',
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
