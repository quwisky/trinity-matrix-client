import { signal } from '@angular/core';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import { MediaService } from '@trinity/data-access-media';
import {
  UrlPreviewService,
  type ThreadSummary,
} from '@trinity/data-access-timeline';
import { PrivacySettingsService } from '@trinity/platform-native';
import { type MediaPayload } from '@trinity/util-matrix';
import { AVATAR_RESOLVER } from '@trinity/ui';
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
    poll: null,
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
      // The media branch renders <trn-media-attachment>, and a previewUrl renders
      // <trn-link-preview>, which inject these.
      providers: [
        MockProvider(MediaService, {
          resolveMedia: () => of(null),
          downloadMedia: () => of({ blob: new Blob(), filename: 'doc.pdf' }),
        }),
        MockProvider(FileSaveService, { save: () => of(undefined) }),
        MockProvider(UrlPreviewService, { preview: () => of(null) }),
        MockProvider(PrivacySettingsService, {
          linkPreviews: signal(true).asReadonly(),
          linkPreviewsInEncrypted: signal(false).asReadonly(),
        }),
      ],
    });
  }

  it('renders an authenticity shield with its reason when the message has one', async () => {
    const { container } = await renderRow({
      row: row({
        shield: { level: 'grey', reason: 'Sent from an unverified device.' },
      }),
    });

    const shield = container.querySelector('[data-testid=msg-shield-grey]');
    expect(shield).not.toBeNull();
    expect(shield?.getAttribute('title')).toBe(
      'Sent from an unverified device.',
    );
  });

  it('renders no shield when the message has none', async () => {
    const { container } = await renderRow({ row: row() });
    expect(container.querySelector('[data-testid^=msg-shield-]')).toBeNull();
  });

  it('shows the shield and link preview on a grouped continuation row too', async () => {
    const { container } = await renderRow({
      row: row({
        showHeader: false, // grouped continuation message
        shield: { level: 'red', reason: 'Sent from an unverified device.' },
        previewUrl: 'https://example.com',
      }),
    });

    expect(
      container.querySelector('[data-testid=msg-shield-red]'),
    ).not.toBeNull();
    expect(container.querySelector('trn-link-preview')).not.toBeNull();
  });

  it('renders a voice message player instead of a media attachment', async () => {
    const { container } = await renderRow({
      row: row({
        kind: 'audio',
        media: {
          kind: 'audio',
          mxc: 'mxc://hs/clip',
          file: null,
          filename: 'Voice message',
          mimeType: 'audio/webm',
          durationMs: 3000,
          isVoice: true,
          waveform: [0, 512, 1024],
          thumbnailMxc: null,
          thumbnailFile: null,
        },
      }),
    });

    expect(
      container.querySelector('[data-testid=voice-message]'),
    ).not.toBeNull();
    expect(container.querySelector('trn-media-attachment')).toBeNull();
  });

  it('renders a link-preview element when the message has a previewUrl', async () => {
    const { container } = await renderRow({
      row: row({ previewUrl: 'https://example.com' }),
    });
    expect(container.querySelector('trn-link-preview')).not.toBeNull();
  });

  it('renders no link-preview element without a previewUrl', async () => {
    const { container } = await renderRow({ row: row() });
    expect(container.querySelector('trn-link-preview')).toBeNull();
  });

  it('renders a state/membership event as a compact system line (no avatar or toolbar)', async () => {
    const { container } = await renderRow({
      row: row({
        kind: 'event',
        summary: 'Alice changed the room name to "General"',
      }),
    });

    const line = container.querySelector('[data-testid=timeline-event]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain(
      'Alice changed the room name to "General"',
    );
    // A system line carries no author header, avatar, or hover toolbar.
    expect(container.querySelector('trn-avatar')).toBeNull();
    expect(container.querySelector('trn-message-toolbar')).toBeNull();
  });

  it('expands the "seen by" reader list when the receipt cluster is clicked', async () => {
    const { container, fixture } = await renderRow({
      row: row({
        readReceipts: [
          { userId: '@a:hs', name: 'Alice', initial: 'A', avatarMxc: null },
        ],
      }),
    });
    expect(container.querySelector('[data-testid=seen-by-list]')).toBeNull();

    (
      container.querySelector('[data-testid=read-receipts]') as HTMLElement
    ).click();
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid=seen-by-list]')?.textContent,
    ).toContain('Seen by Alice');
  });

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
        poll: null,
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
