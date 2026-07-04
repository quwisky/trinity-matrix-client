import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, vi } from 'vitest';
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
  beforeEach(() =>
    TestBed.configureTestingModule({
      imports: [MessageRowComponent],
      // The media branch renders <trn-media-attachment>, which injects these.
      providers: [
        {
          provide: MediaService,
          useValue: {
            resolveMedia: () => of(null),
            downloadMedia: () => of({ blob: new Blob(), filename: 'doc.pdf' }),
            pin: vi.fn(),
            unpin: vi.fn(),
          },
        },
        { provide: FileSaveService, useValue: { save: () => of(undefined) } },
      ],
    }),
  );

  it('renders a plain caption below a media attachment', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput(
      'row',
      row({ kind: 'file', media: fileMedia(), caption: 'look at this' }),
    );
    fixture.detectChanges();

    const el = fixture.nativeElement;
    expect(el.querySelector('trn-media-attachment')).toBeTruthy();
    expect(el.querySelector('.msg__text')?.textContent).toContain(
      'look at this',
    );
  });

  it('renders a rich (HTML) caption below a media attachment', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput(
      'row',
      row({
        kind: 'file',
        media: fileMedia(),
        caption: 'look here',
        captionHtml: '<strong>look here</strong>',
      }),
    );
    fixture.detectChanges();

    const html = fixture.nativeElement.querySelector('.msg__text--html');
    expect(html?.innerHTML).toContain('<strong>look here</strong>');
  });

  it('renders no caption text for an uncaptioned media message', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput(
      'row',
      row({
        kind: 'file',
        media: fileMedia(),
        caption: null,
        captionHtml: null,
      }),
    );
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('trn-media-attachment'),
    ).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.msg__text')).toBeNull();
  });

  it('renders the message body and the hover toolbar', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput('row', row());
    fixture.detectChanges();

    const el = fixture.nativeElement;
    expect(el.querySelector('.msg')).toBeTruthy();
    expect(el.textContent).toContain('hello');
    expect(el.querySelector('trn-message-toolbar')).toBeTruthy();
  });

  it('shows a thread indicator and emits openThread with the root id on click', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput('row', row());
    fixture.componentRef.setInput('threadSummary', summary({ replyCount: 3 }));
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('.msg__thread');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('3 replies');
    expect(btn.textContent).toContain('last reply');

    let opened = '';
    fixture.componentInstance.openThread.subscribe((id) => (opened = id));
    btn.click();
    expect(opened).toBe('$1');
  });

  it('uses the singular for a single reply', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput('row', row());
    fixture.componentRef.setInput('threadSummary', summary({ replyCount: 1 }));
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.msg__thread').textContent,
    ).toContain('1 reply');
  });

  it('shows an unread badge on the thread indicator when the thread is unread', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput('row', row());
    fixture.componentRef.setInput(
      'threadSummary',
      summary({ unreadCount: 5, highlight: true }),
    );
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('.msg__thread-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('5');
    expect(badge.classList.contains('msg__thread-badge--highlight')).toBe(true);
    // The count rides on the (aria-hidden badge's) button label for SR users.
    expect(
      fixture.nativeElement
        .querySelector('.msg__thread')
        .getAttribute('aria-label'),
    ).toContain('5 unread');
  });

  it('omits the unread badge when the thread is read', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput('row', row());
    fixture.componentRef.setInput('threadSummary', summary({ unreadCount: 0 }));
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.msg__thread-badge'),
    ).toBeNull();
  });

  it('omits the thread indicator when there is no summary', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput('row', row());
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.msg__thread')).toBeNull();
  });

  it('hides the toolbar and retry affordance in read-only (thread) mode', () => {
    const fixture = TestBed.createComponent(MessageRowComponent);
    fixture.componentRef.setInput('row', row({ status: 'failed' }));
    fixture.componentRef.setInput('readOnly', true);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    expect(el.querySelector('trn-message-toolbar')).toBeNull();
    expect(el.querySelector('.msg__retry')).toBeNull();
  });
});
