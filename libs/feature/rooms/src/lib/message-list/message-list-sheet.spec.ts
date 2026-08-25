import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrnActionSheetService } from '@trinity/components/overlay';
import { type MessageView } from '@trinity/util/matrix';
import { MessageListBase } from './message-list-base';
import { TrnFileDropDirective } from '../shared/file-drop.directive';

/**
 * The mobile long press opens its sheet HERE, on the list, rather than on the row that was
 * pressed. This file is the reason why.
 *
 * A row is destroyed by ordinary things: a redaction, an edit, the local-echo id swap when
 * your own send lands, or simply scrolling out of the virtual window — which happens behind
 * the sheet's own backdrop, where the reader cannot see it. An `output()` on a destroyed
 * component is a SILENT no-op, so a sheet holding the row's handlers becomes a menu where
 * every row is still tappable and nothing happens.
 */
@Component({
  selector: 'trn-test-sheet-list',
  template: '<div #scroll></div>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [
    { directive: TrnFileDropDirective, inputs: [], outputs: [] },
  ],
})
class TestListComponent extends MessageListBase {
  override jumpTo(): void {
    // No scroll container to jump within.
  }
}

function msg(id: string): MessageView {
  return {
    id,
    senderId: '@a:hs',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: `body ${id}`,
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
  };
}

/** The sheet payload the list handed the service on the last `open()`. */
function lastSheet(open: ReturnType<typeof vi.fn>) {
  return open.mock.calls.at(-1)?.[0] as {
    buttons: { text: string; testId?: string; handler?: () => void }[];
    reactions?: { key: string; handler: () => void }[];
  };
}

function build() {
  const open = vi.fn().mockReturnValue({ close: vi.fn() });
  TestBed.configureTestingModule({
    providers: [{ provide: TrnActionSheetService, useValue: { open } }],
  });
  const fixture = TestBed.createComponent(TestListComponent);
  fixture.componentRef.setInput('roomId', '!r:hs');
  fixture.componentRef.setInput('messages', [msg('$1')]);
  fixture.detectChanges();
  return { fixture, cmp: fixture.componentInstance, open };
}

describe('MessageListBase — the mobile action sheet', () => {
  afterEach(() => vi.restoreAllMocks());

  it('offers the row its actions, with a cancel and the quick reactions', () => {
    const { cmp, open } = build();

    cmp.onRowLongPress(cmp.rows()[0]);

    const sheet = lastSheet(open);
    const labels = sheet.buttons.map((b) => b.text);
    expect(labels).toContain('Reply');
    expect(labels).toContain('Copy link');
    expect(labels.at(-1)).toBe('Cancel');
    expect(sheet.reactions?.length).toBe(6);
    // Named, so a screen reader does not announce a bare "dialog".
    expect(open.mock.calls.at(-1)?.[1]).toBe('Message actions');
  });

  it('dispatches through the same handler the hover toolbar uses', () => {
    const { cmp, open } = build();
    const onRowAction = vi.spyOn(cmp, 'onRowAction');

    cmp.onRowLongPress(cmp.rows()[0]);
    lastSheet(open)
      .buttons.find((b) => b.text === 'Reply')
      ?.handler?.();

    expect(onRowAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: '$1' }),
      { type: 'reply' },
    );
  });

  it('still dispatches after the row that was pressed has gone', () => {
    // THE test for this design. The sheet captured a row SNAPSHOT and calls the list, so
    // the row component's lifetime is irrelevant — here the row is removed from the list
    // entirely (a redaction, or the window scrolling past it) while the sheet is open.
    const { fixture, cmp, open } = build();
    const onRowAction = vi.spyOn(cmp, 'onRowAction');
    const pressed = cmp.rows()[0];

    cmp.onRowLongPress(pressed);
    fixture.componentRef.setInput('messages', []);
    fixture.detectChanges();
    expect(cmp.rows().length).toBe(0);

    lastSheet(open)
      .buttons.find((b) => b.text === 'Reply')
      ?.handler?.();

    expect(onRowAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: '$1' }),
      { type: 'reply' },
    );
  });

  it('reacts with the emoji that was tapped', () => {
    const { cmp, open } = build();
    const onRowAction = vi.spyOn(cmp, 'onRowAction');

    cmp.onRowLongPress(cmp.rows()[0]);
    lastSheet(open).reactions?.[0].handler();

    expect(onRowAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: '$1' }),
      {
        type: 'react',
        key: '👍',
      },
    );
  });

  it('closes the open sheet before opening another', () => {
    // Two long presses in a row, or a press while a sheet is already up: one sheet.
    const close = vi.fn();
    const open = vi.fn().mockReturnValue({ close });
    TestBed.configureTestingModule({
      providers: [{ provide: TrnActionSheetService, useValue: { open } }],
    });
    const fixture = TestBed.createComponent(TestListComponent);
    fixture.componentRef.setInput('roomId', '!r:hs');
    fixture.componentRef.setInput('messages', [msg('$1'), msg('$2')]);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    cmp.onRowLongPress(cmp.rows()[0]);
    cmp.onRowLongPress(cmp.rows()[1]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('closes the sheet when the room changes', () => {
    // A sheet is about one message in one room; left standing over a different timeline it
    // offers actions against an event that is no longer on screen.
    const close = vi.fn();
    const open = vi.fn().mockReturnValue({ close });
    TestBed.configureTestingModule({
      providers: [{ provide: TrnActionSheetService, useValue: { open } }],
    });
    const fixture = TestBed.createComponent(TestListComponent);
    fixture.componentRef.setInput('roomId', '!r:hs');
    fixture.componentRef.setInput('messages', [msg('$1')]);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    cmp.onRowLongPress(cmp.rows()[0]);

    fixture.componentRef.setInput('roomId', '!other:hs');
    fixture.detectChanges();

    expect(close).toHaveBeenCalled();
  });

  it('offers only the actions the caps allow', () => {
    // The sheet is built from the same `rowCaps` the hover toolbar receives. Building it
    // from the overflow menu alone — the obvious shortcut — would silently drop Reply,
    // Reply in thread and the reactions, which are the bar's own buttons and the three
    // most-used things on it.
    const { cmp, open } = build();

    cmp.onRowLongPress(cmp.rows()[0]);

    const labels = lastSheet(open).buttons.map((b) => b.text);
    // Default caps: no pin, no edit, no delete, and quoting is off for a row with no text
    // worth quoting — so none of those may appear.
    expect(labels).not.toContain('Pin message');
    expect(labels).not.toContain('Edit message');
    expect(labels).not.toContain('Delete message');
    // Always available on a writable row.
    expect(labels).toContain('Reply');
    expect(labels).toContain('Forward');
    expect(labels).toContain('Report message');
  });

  it('adds the permitted actions, and says Unpin for a pinned message', () => {
    const { fixture, cmp, open } = build();
    fixture.componentRef.setInput('canPin', true);
    fixture.componentRef.setInput('pinnedIds', ['$1']);
    fixture.detectChanges();

    cmp.onRowLongPress(cmp.rows()[0]);

    const labels = lastSheet(open).buttons.map((b) => b.text);
    expect(labels).toContain('Unpin message');
    expect(labels).not.toContain('Pin message');
  });

  it('marks Delete destructive and rules it off from the rest', () => {
    // Two 44px targets flush against each other, one of them irreversible, is the shape
    // this separator exists to break up.
    //
    // Asserted with `toBeDefined()` first, deliberately: an earlier version fell back to
    // "then Delete must be absent" when it could not find the row, so BOTH branches passed
    // and removing the row from the sheet entirely left it green.
    const { fixture, cmp, open } = build();
    fixture.componentRef.setInput('canRedactOthers', true);
    fixture.detectChanges();

    cmp.onRowLongPress(cmp.rows()[0]);

    const remove = lastSheet(open).buttons.find(
      (b) => b.text === 'Delete message',
    ) as { role?: string; separatorBefore?: boolean } | undefined;
    expect(remove).toBeDefined();
    expect(remove?.role).toBe('destructive');
    expect(remove?.separatorBefore).toBe(true);
  });

  it('gives every row a harness hook', () => {
    // CLAUDE.md: keep `data-testid` on interactive elements, because the Playwright specs
    // drive them. A sheet row without one is undrivable.
    const { cmp, open } = build();

    cmp.onRowLongPress(cmp.rows()[0]);

    const actionable = lastSheet(open).buttons.filter(
      (b) => b.text !== 'Cancel',
    );
    expect(actionable.length).toBeGreaterThan(0);
    for (const button of actionable) {
      expect(button.testId).toBeTruthy();
    }
  });
});
