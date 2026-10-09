import { render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { ComposerBannerComponent } from './composer-banner.component';

describe('ComposerBannerComponent', () => {
  it('shows nothing while neither editing nor replying', async () => {
    const { container } = await render(ComposerBannerComponent, { inputs: {} });

    expect(container.querySelector('.composer__banner')).toBeNull();
  });

  it('announces an edit and cancels it', async () => {
    const cancelEdit = vi.fn();
    const { container } = await render(ComposerBannerComponent, {
      inputs: { editing: true },
      on: { cancelEdit },
    });

    expect(container.querySelector('.composer__banner')?.textContent).toContain(
      'Editing message',
    );
    screen.getByRole('button', { name: 'Cancel edit' }).click();
    expect(cancelEdit).toHaveBeenCalledTimes(1);
  });

  it('names the author being replied to and cancels the reply', async () => {
    const cancelReply = vi.fn();
    const { container } = await render(ComposerBannerComponent, {
      inputs: { replyingTo: 'Ada' },
      on: { cancelReply },
    });

    expect(container.querySelector('.composer__banner')?.textContent).toContain(
      'Replying to Ada',
    );
    screen.getByRole('button', { name: 'Cancel reply' }).click();
    expect(cancelReply).toHaveBeenCalledTimes(1);
  });

  it('prefers the edit banner over the reply banner', async () => {
    const { container } = await render(ComposerBannerComponent, {
      inputs: { editing: true, replyingTo: 'Ada' },
    });

    expect(container.textContent).toContain('Editing message');
    expect(container.textContent).not.toContain('Replying to');
  });
});
