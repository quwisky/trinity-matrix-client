import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import {
  MediaService,
  type MediaPayload,
  type ThreadSummary,
} from '@trinity/core';
import { FileSaveService } from '../media-save/file-save.service';
import { MessageRowComponent, type MessageRow } from './message-row.component';

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '$1',
    senderId: '@a:hs',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: 'hello',
    html: null,
    timestamp: 1000,
    isOwn: false,
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'text',
    media: null,
    caption: null,
    captionHtml: null,
    showHeader: true,
    ...overrides,
  };
}

/** A download-only file attachment — `kind:'file'` skips the async thumbnail
 * resolve, so the row renders synchronously in jsdom. */
function fileMedia(overrides: Partial<MediaPayload> = {}): MediaPayload {
  return {
    kind: 'file',
    mxc: 'mxc://hs/doc',
    file: null,
    filename: 'doc.pdf',
    mimeType: 'application/pdf',
    thumbnailMxc: null,
    thumbnailFile: null,
    ...overrides,
  };
}

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    rootEventId: '$1',
    rootPreview: 'the root',
    rootSenderName: 'Alice',
    replyCount: 3,
    latestReplyTs: 1000,
    latestActivityTs: 1000,
    latestReplyPreview: 'a reply',
    latestReplySenderName: 'Bob',
    participants: [],
    unreadCount: 0,
    highlight: false,
    ...overrides,
  };
}

describe('MessageRowComponent', () => {
  function renderRow(inputs: {
    row: MessageRow;
    threadSummary?: ThreadSummary | null;
    readOnly?: boolean;
  }) {
    return render(MessageRowComponent, {
      inputs,
      // The media branch renders <trn-media-attachment>, which injects these.
      providers: [
        MockProvider(MediaService, {
          resolveMedia: () => of(null),
          downloadMedia: () => of({ blob: new Blob(), filename: 'doc.pdf' }),
        }),
        MockProvider(FileSaveService, { save: () => of(undefined) }),
      ],
    });
  }

  it('renders a plain caption below a media attachment', async () => {
    const { container } = await renderRow({
      row: row({ kind: 'file', media: fileMedia(), caption: 'look at this' }),
    });

    expect(container.querySelector('trn-media-attachment')).toBeTruthy();
    expect(container.querySelector('.msg__text')?.textContent).toContain(
      'look at this',
    );
  });

  it('renders a rich (HTML) caption below a media attachment', async () => {
    const { container } = await renderRow({
      row: row({
        kind: 'file',
        media: fileMedia(),
        caption: 'look here',
        captionHtml: '<strong>look here</strong>',
      }),
    });

    const html = container.querySelector('.msg__text--html');
    expect(html?.innerHTML).toContain('<strong>look here</strong>');
  });

  it('renders no caption text for an uncaptioned media message', async () => {
    const { container } = await renderRow({
      row: row({
        kind: 'file',
        media: fileMedia(),
        caption: null,
        captionHtml: null,
      }),
    });

    expect(container.querySelector('trn-media-attachment')).toBeTruthy();
    expect(container.querySelector('.msg__text')).toBeNull();
  });

  it('renders the message body and the hover toolbar', async () => {
    const { container } = await renderRow({ row: row() });

    expect(container.querySelector('.msg')).toBeTruthy();
    expect(container.textContent).toContain('hello');
    expect(container.querySelector('trn-message-toolbar')).toBeTruthy();
  });

  it('shows a thread indicator and emits openThread with the root id on click', async () => {
    const { fixture, container } = await renderRow({
      row: row(),
      threadSummary: summary({ replyCount: 3 }),
    });

    const btn = container.querySelector<HTMLElement>('.msg__thread');
    expect(btn).toBeTruthy();
    expect(btn?.textContent).toContain('3 replies');
    expect(btn?.textContent).toContain('last reply');

    let opened = '';
    fixture.componentInstance.openThread.subscribe((id) => (opened = id));
    btn?.click();
    expect(opened).toBe('$1');
  });

  it('uses the singular for a single reply', async () => {
    const { container } = await renderRow({
      row: row(),
      threadSummary: summary({ replyCount: 1 }),
    });

    expect(container.querySelector('.msg__thread')?.textContent).toContain(
      '1 reply',
    );
  });

  it('shows an unread badge on the thread indicator when the thread is unread', async () => {
    const { container } = await renderRow({
      row: row(),
      threadSummary: summary({ unreadCount: 5, highlight: true }),
    });

    const badge = container.querySelector('.msg__thread-badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain('5');
    expect(badge?.classList.contains('msg__thread-badge--highlight')).toBe(
      true,
    );
    // The count rides on the (aria-hidden badge's) button label for SR users.
    expect(
      container.querySelector('.msg__thread')?.getAttribute('aria-label'),
    ).toContain('5 unread');
  });

  it('omits the unread badge when the thread is read', async () => {
    const { container } = await renderRow({
      row: row(),
      threadSummary: summary({ unreadCount: 0 }),
    });

    expect(container.querySelector('.msg__thread-badge')).toBeNull();
  });

  it('omits the thread indicator when there is no summary', async () => {
    const { container } = await renderRow({ row: row() });

    expect(container.querySelector('.msg__thread')).toBeNull();
  });

  it('hides the toolbar and retry affordance in read-only (thread) mode', async () => {
    const { container } = await renderRow({
      row: row({ status: 'failed' }),
      readOnly: true,
    });

    expect(container.querySelector('trn-message-toolbar')).toBeNull();
    expect(container.querySelector('.msg__retry')).toBeNull();
  });
});
