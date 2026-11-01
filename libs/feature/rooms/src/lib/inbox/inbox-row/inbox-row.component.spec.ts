import { provideTrnIcons } from '@trinity/components/foundations';
import type {
  InboxPreview,
  InboxRow,
} from '@trinity/data-access/notifications';
import { GENERIC_BODY } from '@trinity/data-access/notifications';
import { render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { InboxRowComponent } from './inbox-row.component';

const ROW: InboxRow = {
  accountId: '@me:hs',
  eventId: '$1',
  roomId: '!r:hs',
  roomName: 'Design review',
  senderName: 'Marek',
  ts: 1_700_000_000_000,
  preview: { kind: 'text', text: 'can you sign off?' },
  unread: false,
  threadRootId: null,
};

const renderRow = (
  row: Partial<InboxRow> = {},
  inputs: { unread?: boolean; current?: boolean } = {},
) =>
  render(InboxRowComponent, {
    inputs: { row: { ...ROW, ...row }, ...inputs },
    providers: [provideTrnIcons()],
  });

describe('InboxRowComponent', () => {
  it('names the button with the room, sender and preview', async () => {
    await renderRow();

    const button = screen.getByRole('button');
    expect(button.getAttribute('data-testid')).toBe('inbox-row');
    expect(button).toHaveAccessibleName(
      /^Design review,\s*Marek: can you sign off\?,\s*\S.*$/,
    );
  });

  it('leaves the sender out when there is none', async () => {
    await renderRow({ senderName: null });

    expect(screen.getByRole('button').querySelector('.row__sender')).toBeNull();
  });

  it.each<[InboxPreview, string]>([
    [{ kind: 'encrypted' }, 'Encrypted message'],
    [{ kind: 'unavailable' }, 'Preview unavailable'],
    [{ kind: 'hidden' }, GENERIC_BODY],
    [{ kind: 'text', text: 'hello' }, 'hello'],
  ])('shows the words for a preview of %j', async (preview, words) => {
    await renderRow({ preview });

    expect(screen.getByRole('button').textContent).toContain(words);
  });

  it('renders a hostile body, sender and room as text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = await renderRow({
      roomName: hostile,
      senderName: hostile,
      preview: { kind: 'text', text: hostile },
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent?.split(hostile).length).toBe(4);
  });

  it('shows the unread dot with a screen-reader word', async () => {
    await renderRow({}, { unread: true });

    const button = screen.getByRole('button');
    expect(button.querySelector('[data-testid=inbox-row-dot]')).not.toBeNull();
    expect(button).toHaveAccessibleName(/, unread$/);
  });

  it('shows no dot and no word when read', async () => {
    await renderRow();

    const button = screen.getByRole('button');
    expect(button.querySelector('[data-testid=inbox-row-dot]')).toBeNull();
    expect(button.textContent).not.toContain('unread');
  });

  it('marks the current row only', async () => {
    const { fixture } = await renderRow();
    expect(screen.getByRole('button').hasAttribute('aria-current')).toBe(false);

    fixture.componentRef.setInput('current', true);
    fixture.detectChanges();

    expect(screen.getByRole('button').getAttribute('aria-current')).toBe(
      'true',
    );
  });

  it('says when it was opened', async () => {
    const opened = vi.fn();
    const { fixture } = await renderRow();
    fixture.componentInstance.opened.subscribe(opened);

    screen.getByRole('button').click();

    expect(opened).toHaveBeenCalledOnce();
  });
});
