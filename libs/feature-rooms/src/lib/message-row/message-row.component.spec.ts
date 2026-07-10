import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import { MediaService } from '@trinity/data-access-media';
import { type ThreadSummary } from '@trinity/data-access-timeline';
import { type MediaPayload } from '@trinity/util-matrix';
import { FileSaveService } from '../media-save/file-save.service';
import {
  MessageRowComponent,
  type MessageRow,
  type MessageRowAction,
  type MessageRowCaps,
} from './message-row.component';

/** Build a row caps object, overriding only the flags a test cares about. */
const caps = (over: Partial<MessageRowCaps> = {}): MessageRowCaps => ({
  editable: false,
  deletable: false,
  canPin: false,
  pinned: false,
  canThread: true,
  readOnly: false,
  ...over,
});

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
    readReceipts: [],
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
    caps?: MessageRowCaps;
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

  it('conceals a spoiler and reveals it on click', async () => {
    // The html is what buildMessageView already ran through sanitizeMatrixHtml — the
    // mx-spoiler class (not data-mx-spoiler) is what survives Angular's [innerHTML]
    // re-sanitization and reaches the DOM.
    const { container } = await renderRow({
      row: row({
        body: 'the answer is 42',
        html: 'the answer is <span class="mx-spoiler" tabindex="0" role="button">42</span>',
      }),
    });

    const spoiler = container.querySelector<HTMLElement>('.mx-spoiler');
    expect(spoiler).toBeTruthy(); // class survived the render-leaf sanitizer
    expect(spoiler?.classList.contains('is-revealed')).toBe(false);

    spoiler!.click();
    expect(spoiler?.classList.contains('is-revealed')).toBe(true);
  });

  it('renders no caption text for an uncaptioned media message', async () => {
    const { container } = await renderRow({
      row: row({
        kind: 'file',
        media: fileMedia(),
        caption: null,
        captionHtml: null,
        readReceipts: [],
      }),
    });

    expect(container.querySelector('trn-media-attachment')).toBeTruthy();
    expect(container.querySelector('.msg__text')).toBeNull();
  });

  it('renders a "seen by" avatar per read receipt with a labelled group', async () => {
    const { container } = await renderRow({
      row: row({
        readReceipts: [
          { userId: '@bob:hs', name: 'Bob', initial: 'B', avatarMxc: null },
          { userId: '@cara:hs', name: 'Cara', initial: 'C', avatarMxc: null },
        ],
      }),
    });

    const receipts = container.querySelector('[data-testid=read-receipts]');
    expect(receipts).toBeTruthy();
    expect(receipts?.querySelectorAll('trn-avatar').length).toBe(2);
    expect(receipts?.getAttribute('aria-label')).toBe('Seen by Bob, Cara');
  });

  it('renders no "seen by" group when nothing has been read', async () => {
    const { container } = await renderRow({ row: row({ readReceipts: [] }) });
    expect(container.querySelector('[data-testid=read-receipts]')).toBeNull();
  });

  it('renders the message body and the hover toolbar', async () => {
    const { container } = await renderRow({ row: row() });

    expect(container.querySelector('.msg')).toBeTruthy();
    expect(container.textContent).toContain('hello');
    expect(container.querySelector('trn-message-toolbar')).toBeTruthy();
  });

  it('shows a thread indicator and emits a thread action on click', async () => {
    const { fixture, container } = await renderRow({
      row: row(),
      threadSummary: summary({ replyCount: 3 }),
    });

    const btn = container.querySelector<HTMLElement>('.msg__thread');
    expect(btn).toBeTruthy();
    expect(btn?.textContent).toContain('3 replies');
    expect(btn?.textContent).toContain('last reply');

    // The row raises a type-only thread action; the host supplies the row id.
    let action: MessageRowAction | undefined;
    fixture.componentInstance.action.subscribe((a) => (action = a));
    btn?.click();
    expect(action).toEqual({ type: 'thread' });
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
      caps: caps({ readOnly: true }),
    });

    expect(container.querySelector('trn-message-toolbar')).toBeNull();
    expect(container.querySelector('.msg__retry')).toBeNull();
  });
});
