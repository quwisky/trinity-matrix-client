import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, waitFor } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import { MediaService } from '@trinity/data-access/media';
import {
  UrlPreviewService,
  type ThreadSummary,
} from '@trinity/data-access/timeline';
import {
  DateTimeFormatService,
  PrivacySettingsService,
} from '@trinity/platform-native';
import { type MediaPayload } from '@trinity/util/matrix';
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
  canQuote: false,
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
          resolveMedia: () => of(''),
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

  // The load-bearing test for #22: the format preference must reach an already-rendered row.
  //
  // This is exactly what a pure pipe cannot do. `| date:` caches on its input, and a
  // timestamp never changes — so `transform()` would be skipped, the preference signal never
  // re-read, and (worse) the view's producer link trimmed on the next pass, leaving the row
  // permanently deaf to the setting rather than merely stale once. Reading the signal through
  // a method invoked from the template re-registers the dependency every pass.
  describe('date and time format', () => {
    /** Local wall-clock instant, so the assertions hold in any timezone. */
    const AFTERNOON = new Date(2026, 6, 24, 15, 45).getTime();

    it('re-renders a row when the format changes, with no input changing', async () => {
      const only = row({ timestamp: AFTERNOON });
      const { container, fixture } = await renderRow({ row: only });
      const format = TestBed.inject(DateTimeFormatService);

      format.setTimeFormat('h12');
      fixture.detectChanges();
      const before = container.querySelector('.msg__time')?.textContent?.trim();
      expect(before).toContain('3:45');

      format.setTimeFormat('h24');
      fixture.detectChanges();

      const after = container.querySelector('.msg__time')?.textContent?.trim();
      expect(after).toContain('15:45');
      expect(after).not.toBe(before);
      // The row object is untouched — an OnPush view refreshed purely because its own
      // template read a signal that changed.
      expect(fixture.componentInstance.row()).toBe(only);
    });

    it('applies the date preference to the header timestamp', async () => {
      const { container, fixture } = await renderRow({
        row: row({ timestamp: AFTERNOON }),
      });
      const format = TestBed.inject(DateTimeFormatService);

      format.setDateFormat('iso');
      fixture.detectChanges();

      expect(container.querySelector('.msg__time')?.textContent).toContain(
        '2026-07-24',
      );
    });

    // The hover gutter on a grouped continuation is the site the issue calls out by name.
    it('applies the time preference to the continuation gutter', async () => {
      const { container, fixture } = await renderRow({
        row: row({ timestamp: AFTERNOON, showHeader: false }),
      });
      const format = TestBed.inject(DateTimeFormatService);

      format.setTimeFormat('h24');
      fixture.detectChanges();

      expect(container.querySelector('.msg__gutter')?.textContent?.trim()).toBe(
        '15:45',
      );
    });
  });

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

    // brn >= 1.2.0 listens on pointerenter, not mouseenter, and opens only for a
    // pointerType of 'mouse' or 'pen' — see the PointerEvent polyfill in
    // test-setup.base.ts for why the pointerType has to survive the trip.
    fireEvent.pointerEnter(shield, { pointerType: 'mouse' });
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

  // Pins brain's own gate, not any device: a touch pointer must not open the tooltip.
  // On brain 1.1 a tap fired a synthesised mouseenter that opened the tooltip and no
  // matching mouseleave to close it, so touch users got one stuck open. This asserts
  // the fix stays fixed — a future bump that re-enables touch fails here rather than
  // silently regressing. The e2e suite cannot cover it: it is a single Desktop Chrome
  // project.
  it('does not open the tooltip for a touch pointer', async () => {
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

    const tip = () =>
      document.body.querySelector('[data-testid=msg-shield-tip]');

    // Fake timers rather than a real sleep: brn opens after a 150ms delay, and a real
    // wait can only ever prove "nothing had appeared yet". A slow box that fired the
    // delay late would pass this test without ever having outlasted it — a false green
    // in the one direction a negative assertion cannot survive.
    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(shield, { pointerType: 'touch' });
      await vi.advanceTimersByTimeAsync(300);
      expect(tip()).toBeNull();

      // Defect control, and the reason the assertion above means anything. On its own,
      // "no tooltip appeared" also passes if the PointerEvent shim were dropped, if
      // [trnTooltip] were removed from the shield, or if brain stopped rendering this
      // testid — every regression it is meant to catch. Driving the SAME element through
      // the SAME plumbing with a mouse pointer must open it.
      fireEvent.pointerEnter(shield, { pointerType: 'mouse' });
      await vi.advanceTimersByTimeAsync(300);
      expect(tip()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    expect(cmp.shieldIcon('red')).toBe('shield-alert');
    expect(cmp.shieldIcon('grey')).toBe('shield-question');
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

  describe('right-click and long-press', () => {
    /** The menu is rendered into a CDK overlay, so it is found on `document`, not in the row. */
    const menuOpen = () =>
      document.querySelectorAll('[data-testid=msg-copy]').length > 0;

    // `isPrimary: true` is part of the DEFAULT on purpose. Only a primary pointer arms a
    // press, so a helper that left it undefined would make every "nothing happened"
    // assertion below pass for the wrong reason — the press would never have been armed at
    // all, and the behaviour each test names would go unexercised.
    const pointer = (type: string, over: Partial<PointerEvent> = {}) =>
      Object.assign(
        new Event(type, { bubbles: true, cancelable: true }),
        { pointerType: 'touch', clientX: 0, clientY: 0, isPrimary: true },
        over,
      ) as unknown as PointerEvent;

    /** The row pins its own action bar open; the bar is not in an overlay. */
    const barRevealed = (container: HTMLElement) =>
      container.querySelector('.msg')?.classList.contains('msg--revealed') ??
      false;

    afterEach(() => {
      // The overlay outlives the fixture; leaving it attached leaks into the next test.
      document
        .querySelectorAll('.cdk-overlay-container')
        .forEach((el) => el.remove());
    });

    it('opens the message actions on right-click, instead of the browser menu', async () => {
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;

      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      await Promise.resolve();

      expect(event.defaultPrevented).toBe(true);
      expect(menuOpen()).toBe(true);
    });

    /** Pretend the user has highlighted text, anchored at `anchorNode`. */
    const selectText = (anchorNode: Node | null) =>
      vi.spyOn(document, 'getSelection').mockReturnValue({
        toString: () => 'some highlighted words',
        anchorNode,
      } as unknown as Selection);

    it('leaves the browser menu alone when text in this row is selected', async () => {
      // Their selection, their menu: a user who has highlighted part of a message is asking
      // for Copy, and replacing that with ours would be a downgrade.
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;
      selectText(el.querySelector('.msg__text'));

      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(menuOpen()).toBe(false);
      vi.mocked(document.getSelection).mockRestore();
    });

    it('still offers its own actions when the selection is in a different row', async () => {
      // A selection is a statement about ONE message. Reading the document-wide selection
      // meant text highlighted anywhere in the timeline suppressed the context menu on every
      // other row until it was cleared.
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;
      const elsewhere = document.createElement('p');
      elsewhere.textContent = 'a different message';
      document.body.append(elsewhere);
      selectText(elsewhere.firstChild);

      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      await Promise.resolve();

      expect(event.defaultPrevented).toBe(true);
      expect(menuOpen()).toBe(true);
      vi.mocked(document.getSelection).mockRestore();
      elsewhere.remove();
    });

    it('reveals the action bar after a long press on touch', async () => {
      // NOT the overflow menu. Reply, Add reaction and Reply in thread are the bar's own
      // buttons and are not in that menu, so opening it would leave a touch user unable to
      // reach the three actions they use most.
      vi.useFakeTimers();
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;

      el.dispatchEvent(pointer('pointerdown'));
      expect(barRevealed(container)).toBe(false); // not yet — a tap is not a press
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      expect(barRevealed(container)).toBe(true);
      vi.useRealTimers();
    });

    it('does not let a second primary pointer leak the first press', async () => {
      // A pen and a finger are BOTH primary (`isPrimary` is per pointer type), so the
      // non-primary guard does not cover this: the second `pointerdown` used to overwrite the
      // timer handle while the first timer stayed scheduled, and cancelling then cleared only
      // the one still reachable. The orphan fired 500ms later and opened the bar with nothing
      // held down. Only clearing the pending timer on the way in prevents it.
      vi.useFakeTimers();
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;

      el.dispatchEvent(pointer('pointerdown'));
      el.dispatchEvent(
        pointer('pointerdown', { pointerType: 'pen', clientX: 80 }),
      );
      el.dispatchEvent(pointer('pointercancel'));
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(barRevealed(container)).toBe(false);
      vi.useRealTimers();
    });

    it('lets a second finger land without restarting the press underway', async () => {
      // The distinguishing case for the non-primary guard, which the test above cannot
      // isolate because clearing the pending timer would also satisfy it. Here the first
      // press is already 400ms along; treating the second finger as a new press would reset
      // that clock and the press would never complete. A real pinch still cancels this, via
      // the `pointercancel` the browser sends when it takes the gesture over.
      vi.useFakeTimers();
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;

      el.dispatchEvent(pointer('pointerdown'));
      vi.advanceTimersByTime(400);
      el.dispatchEvent(
        pointer('pointerdown', { isPrimary: false, clientX: 80 }),
      );
      vi.advanceTimersByTime(200);
      await Promise.resolve();

      expect(barRevealed(container)).toBe(true);
      vi.useRealTimers();
    });

    it.each(['pointerup', 'pointercancel', 'pointerleave'])(
      'ends the press on %s',
      async (endEvent) => {
        // Each of these is wired separately in the template, so each can be dropped
        // separately — and a press that outlives the finger opens the bar on its own.
        vi.useFakeTimers();
        const { container } = await renderRow({ row: row(), caps: caps() });
        const el = container.querySelector('.msg') as HTMLElement;

        el.dispatchEvent(pointer('pointerdown'));
        el.dispatchEvent(pointer(endEvent));
        vi.advanceTimersByTime(1000);
        await Promise.resolve();

        expect(barRevealed(container)).toBe(false);
        vi.useRealTimers();
      },
    );

    it('puts the bar away again when something outside the row is pressed', async () => {
      vi.useFakeTimers();
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;

      el.dispatchEvent(pointer('pointerdown'));
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      expect(barRevealed(container)).toBe(true);

      document.body.dispatchEvent(
        new Event('pointerdown', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();

      expect(barRevealed(container)).toBe(false);
      vi.useRealTimers();
    });

    it('leaves a right-click on a link to the browser', async () => {
      // "Open link in new tab" and "Save image as…" exist nowhere else, so swallowing the
      // native menu over a link or an attachment is a straight loss.
      const { container } = await renderRow({
        row: row({ html: '<a href="https://example.com">a link</a>' }),
        caps: caps(),
      });
      const link = container.querySelector('a') as HTMLElement;
      expect(link).not.toBeNull();

      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      link.dispatchEvent(event);
      await Promise.resolve();

      expect(event.defaultPrevented).toBe(false);
      expect(menuOpen()).toBe(false);
    });

    it('does not fire at the end of a scroll', async () => {
      // A press that travels is a flick, and a timeline is mostly flicked. Without this the
      // menu would appear every time a scroll happened to start on a message.
      vi.useFakeTimers();
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;

      el.dispatchEvent(pointer('pointerdown'));
      el.dispatchEvent(pointer('pointermove', { clientY: 40 }));
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      expect(barRevealed(container)).toBe(false);
      vi.useRealTimers();
    });

    it('ignores a long press from a mouse, which has a right button for this', async () => {
      vi.useFakeTimers();
      const { container } = await renderRow({ row: row(), caps: caps() });
      const el = container.querySelector('.msg') as HTMLElement;

      el.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }));
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      expect(barRevealed(container)).toBe(false);
      vi.useRealTimers();
    });
  });
});
