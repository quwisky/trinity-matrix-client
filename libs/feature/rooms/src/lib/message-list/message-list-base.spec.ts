import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MessageView } from '@trinity/util/matrix';
import { MessageListBase } from './message-list-base';
import { TrnFileDropDirective } from '../shared/file-drop.directive';

/**
 * A concrete list with no scroll strategy of its own, so what is exercised here is the
 * base's own effects rather than a subclass's anchoring/backfill work.
 */
@Component({
  selector: 'trn-test-message-list',
  template: '<div #scroll></div>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The base injects it, so every list must carry it — a subclass that forgets loses
  // drag-and-drop, and this stub standing in for one has to be honest about that.
  hostDirectives: [TrnFileDropDirective],
})
class TestMessageListComponent extends MessageListBase {
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

/**
 * A controllable frame queue. jsdom has no rAF, and what this spec is about is exactly
 * which scheduled frames survive to run — so the stub hands back real handles and
 * honours the cancellation.
 */
function stubFrames() {
  let nextHandle = 1;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, cb);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle);
  });
  return {
    flush: () => {
      const due = Array.from(pending.values());
      pending.clear();
      for (const cb of due) {
        cb(0);
      }
    },
  };
}

/** Spy on the (protected) measurement the deferred frame performs. */
function spyOnMeasure(cmp: TestMessageListComponent) {
  return vi.spyOn(
    cmp as unknown as { updateJumpToUnread: () => void },
    'updateJumpToUnread',
  );
}

describe('MessageListBase jump-to-unread scheduling', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A detached fixture (not render()) so the only change detection is the explicit
  // detectChanges() below — this is a timing test.
  function create() {
    const fixture = TestBed.createComponent(TestMessageListComponent);
    fixture.componentRef.setInput('firstUnreadId', '$b');
    fixture.componentRef.setInput('messages', [msg('$a')]);
    fixture.detectChanges();
    return fixture;
  }

  // The effect depends on messages(), so a burst of sync ticks between two frames used
  // to queue one forced-layout measurement (scrollTop/clientHeight/offsetTop) per tick,
  // on the hottest surface in the app, each computing the same answer.
  it('measures once for a burst of timeline ticks', () => {
    const frames = stubFrames();
    const fixture = create();
    frames.flush();
    const measure = spyOnMeasure(fixture.componentInstance);

    for (const messages of [
      [msg('$a'), msg('$b')],
      [msg('$a'), msg('$b'), msg('$c')],
      [msg('$a'), msg('$b'), msg('$c'), msg('$d')],
    ]) {
      fixture.componentRef.setInput('messages', messages);
      fixture.detectChanges();
    }
    frames.flush();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('still measures on the next frame after the timeline changes', () => {
    const frames = stubFrames();
    const fixture = create();
    frames.flush();
    const measure = spyOnMeasure(fixture.componentInstance);

    fixture.componentRef.setInput('messages', [msg('$a'), msg('$b')]);
    fixture.detectChanges();
    expect(measure).not.toHaveBeenCalled(); // deferred, so the row is laid out first

    frames.flush();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('drops the pending frame when the list is destroyed', () => {
    const frames = stubFrames();
    const fixture = create();
    frames.flush();
    const measure = spyOnMeasure(fixture.componentInstance);

    fixture.componentRef.setInput('messages', [msg('$a'), msg('$b')]);
    fixture.detectChanges();
    fixture.destroy();
    frames.flush();

    expect(measure).not.toHaveBeenCalled();
  });
});

describe('MessageListBase batch caption routing', () => {
  it('sends a batch caption plainly, even when an edit is in progress', async () => {
    // The caption was typed before an upload that can take minutes. `onSubmit` routes by the
    // composer's CURRENT state, so putting it through there would apply it as the edit the
    // user has started since — rewriting a message already visible in the room.
    const fixture = TestBed.createComponent(TestMessageListComponent);
    fixture.componentRef.setInput('messages', [msg('$a')]);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    const sent: string[] = [];
    const edited: string[] = [];
    const replied: string[] = [];
    cmp.send.subscribe((e) => sent.push(e.body));
    cmp.editMessage.subscribe((e) => edited.push(e.body));
    cmp.reply.subscribe((e) => replied.push(e.body));

    cmp.editingId.set('$a');
    cmp['onBatchCaption']({ text: 'check these out', mentions: [] });

    expect(sent).toEqual(['check these out']);
    expect(edited).toEqual([]);
    expect(cmp.editingId()).toBe('$a'); // and the edit the user is writing is untouched

    // Same for a reply started while the files were going out.
    cmp.editingId.set(null);
    cmp.replyingToId.set('$a');
    cmp['onBatchCaption']({ text: 'and these', mentions: [] });

    expect(sent).toEqual(['check these out', 'and these']);
    expect(replied).toEqual([]);
  });
});
