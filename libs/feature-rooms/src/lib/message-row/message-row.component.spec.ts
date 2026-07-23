import { signal } from '@angular/core';
import { fireEvent, render, waitFor } from '@trinity/testing';
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

  it('raises the who-reacted request from the reaction pills', async () => {
    const { fixture, container } = await renderRow({
      row: row({
        reactions: [
          { key: '👍', count: 2, reacted: false, reactors: ['Alice', 'Bob'] },
        ],
      }),
    });
    const actions: MessageRowAction[] = [];
    fixture.componentInstance.action.subscribe((a) => actions.push(a));

    container
      .querySelector<HTMLButtonElement>('[data-testid=reactions-who]')!
      .click();

    expect(actions).toEqual([{ type: 'reactors' }]);
  });

  it('renders an authenticity shield with its reason when the message has one', async () => {
    const { container } = await renderRow({
      row: row({
        shield: {
          level: 'grey',
          reason: 'Sent from an unverified device.',
          explanation: 'Verify this person to be sure.',
        },
      }),
    });

    const shield = container.querySelector('[data-testid=msg-shield-grey]');
    expect(shield).not.toBeNull();
    expect(shield?.getAttribute('aria-label')).toBe(
      'Sent from an unverified device.',
    );
    // The custom tooltip carries the wording now, so the native one must be gone —
    // two tooltips on the same icon would fight over the same hover.
    expect(shield?.getAttribute('title')).toBeNull();
    // Hover/focus is the only way in, so the icon has to be focusable.
    expect(shield?.getAttribute('tabindex')).toBe('0');
  });

  // The icon alone cannot say what is wrong; the tooltip is where the meaning lives, so
  // it has to actually open and carry BOTH halves — the finding and what it means.
  it('opens a tooltip explaining the shield on hover', async () => {
    const { container } = await renderRow({
      row: row({
        shield: {
          level: 'red',
          reason: 'Sent from a device its owner hasn’t verified.',
          explanation: 'Only its owner can confirm the device is theirs.',
        },
      }),
    });
    const shield = container.querySelector(
      '[data-testid=msg-shield-red]',
    ) as HTMLElement;

    fireEvent.mouseEnter(shield);
    // brn opens after a 150ms show delay, into a CDK overlay outside this container.
    const tip = await waitFor(() => {
      const found = document.body.querySelector('[data-testid=msg-shield-tip]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(tip.textContent).toContain('hasn’t verified');
    expect(tip.textContent).toContain('Only its owner can confirm');
    // Wired as the icon's description so a screen reader reads it on focus.
    expect(shield.getAttribute('aria-describedby')).not.toBeNull();
  });

  // Hover is not an input method everyone has. The icon is focusable precisely so the
  // explanation is reachable by keyboard, which is only true if focus opens it too.
  it('opens the same tooltip on keyboard focus', async () => {
    const { container } = await renderRow({
      row: row({
        shield: {
          level: 'grey',
          reason: 'Sent by a user you haven’t verified.',
          explanation: 'Verify this person to be sure.',
        },
      }),
    });
    const shield = container.querySelector(
      '[data-testid=msg-shield-grey]',
    ) as HTMLElement;

    shield.focus();
    expect(document.activeElement).toBe(shield); // tabindex actually took
    fireEvent.focus(shield);

    const tip = await waitFor(() => {
      const found = document.body.querySelector('[data-testid=msg-shield-tip]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(tip.textContent).toContain('Verify this person to be sure.');
  });

  it('maps shield severity to a distinct icon shape (colour-independent)', async () => {
    const { fixture } = await renderRow({ row: row() });
    const cmp = fixture.componentInstance;

    // Red = warning (alert), grey = caution (question) — different shapes so the two
    // are distinguishable without colour. The template binds both shields to this.
    expect(cmp.shieldIcon('red')).toBe('lucideShieldAlert');
    expect(cmp.shieldIcon('grey')).toBe('lucideShieldQuestion');
  });

  // The shield qualifies the whole message, so it hangs off the row itself rather than
  // sitting inside the header or the body — that is what lets one element serve both
  // layouts and park at the row's trailing edge instead of trailing the text.
  it.each([true, false])(
    'hangs the shield off the row itself (showHeader=%s)',
    async (showHeader) => {
      const { container } = await renderRow({
        row: row({
          showHeader,
          shield: {
            level: 'grey',
            reason: 'Sent from an unverified device.',
            explanation: 'Verify this person to be sure.',
          },
        }),
      });

      const shields = container.querySelectorAll('[data-testid^=msg-shield-]');
      expect(shields).toHaveLength(1);
      expect(shields[0].parentElement?.classList.contains('msg')).toBe(true);
    },
  );

  // The marker is the only way into the edit history, and it has to work identically in
  // both layouts — a grouped message has no header for it to sit in.
  it.each([true, false])(
    'raises edit-history from the (edited) marker (showHeader=%s)',
    async (showHeader) => {
      const actions: MessageRowAction[] = [];
      const { container } = await render(MessageRowComponent, {
        inputs: { row: row({ showHeader, edited: true }), caps: caps() },
        on: { action: (a: MessageRowAction) => actions.push(a) },
      });

      const marker = container.querySelector(
        '[data-testid=msg-edited]',
      ) as HTMLElement;
      fireEvent.click(marker);

      expect(actions).toEqual([{ type: 'edit-history' }]);
      // The accessible name keeps the visible text (WCAG 2.5.3 Label in Name), so a
      // voice-control user can say what they see.
      expect(marker.getAttribute('aria-label')).toContain('(edited)');
    },
  );

  it('offers no marker on a message that was never edited', async () => {
    const { container } = await render(MessageRowComponent, {
      inputs: { row: row(), caps: caps() },
    });

    expect(container.querySelector('[data-testid=msg-edited]')).toBeNull();
  });

  // `edited` comes from the SDK's replacing event, which survives a redaction that
  // arrived from the server — so a deleted message can still claim to be edited, and its
  // edits do still exist. Offering the history there would undo the deletion.
  it.each([
    ['deleted', { kind: 'redacted' as const }],
    ['undecryptable', { decryptionFailed: true }],
  ])(
    'offers no marker on a %s message, even if flagged edited',
    async (_label, over) => {
      const { container } = await render(MessageRowComponent, {
        inputs: { row: row({ edited: true, ...over }), caps: caps() },
      });

      expect(container.querySelector('[data-testid=msg-edited]')).toBeNull();
    },
  );

  it('renders no shield when the message has none', async () => {
    const { container } = await renderRow({ row: row() });
    expect(container.querySelector('[data-testid^=msg-shield-]')).toBeNull();
  });

  it('shows the shield and link preview on a grouped continuation row too', async () => {
    const { container } = await renderRow({
      row: row({
        showHeader: false, // grouped continuation message
        shield: {
          level: 'red',
          reason: 'Sent from an unverified device.',
          explanation: 'Verify this person to be sure.',
        },
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
