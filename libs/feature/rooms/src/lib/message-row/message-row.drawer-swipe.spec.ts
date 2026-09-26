import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TrnActionSheetService,
  TrnDialogService,
} from '@trinity/components/overlay';
import { MediaService } from '@trinity/data-access/media';
import { UrlPreviewService } from '@trinity/data-access/timeline';
import { PrivacySettingsService } from '@trinity/platform-native';
import { HostFileExportService } from '@trinity/runtime/host';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawerSwipeDirective } from '../rooms/drawer-swipe.directive';
import {
  MessageRowComponent,
  type MessageRow,
  type MessageRowCaps,
} from './message-row.component';

const state = vi.hoisted(() => ({ mobile: true }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => state.mobile,
}));

const LONG_PRESS_MS = 500;

const message: MessageRow = {
  id: '$thread-reply',
  senderId: '@alice:example.org',
  senderName: 'Alice',
  senderInitial: 'A',
  senderAvatarMxc: null,
  body: 'A reply inside the open thread',
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
};

const capabilities: MessageRowCaps = {
  editable: false,
  deletable: false,
  canPin: false,
  pinned: false,
  canThread: true,
  canQuote: true,
  readOnly: false,
};

@Component({
  imports: [DrawerSwipeDirective, MessageRowComponent],
  template: `
    <div data-shell-root>
      <div
        data-testid="drawer-gesture-host"
        trnDrawerSwipe
        [drawerEnabled]="true"
        [drawerOpen]="true"
        [drawerWidth]="240"
        (closed)="drawerEvents.push('closed')"
      >
        <trn-message-row
          [row]="message"
          [caps]="capabilities"
          swipeDirection="off"
          (longPress)="openMessageActions()"
        />
      </div>
    </div>
  `,
})
class HostComponent {
  private readonly actionSheet = inject(TrnActionSheetService);

  readonly message = message;
  readonly capabilities = capabilities;
  readonly drawerEvents: string[] = [];
  longPresses = 0;

  openMessageActions(): void {
    this.longPresses += 1;
    this.actionSheet.open(
      { buttons: [{ text: 'Reply in thread' }] },
      'Message actions',
    );
  }
}

/** A touch pointer at (x, y), `at` ms into the gesture. */
function touch(
  type: string,
  x: number,
  y: number,
  at: number,
  bubbles = true,
): PointerEvent {
  const event = new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    bubbles,
  });
  Object.defineProperty(event, 'timeStamp', { value: at });
  return event;
}

interface GestureHarness {
  readonly host: HostComponent;
  readonly move: (x: number, y: number, at: number) => void;
  readonly down: (x: number, y: number, at?: number) => void;
  readonly up: (x: number, y: number, at: number) => void;
}

async function renderGesture(): Promise<GestureHarness> {
  const result = await render(HostComponent, {
    providers: [
      MockProvider(MediaService, {
        resolveMedia: () => of(''),
        downloadMedia: () => of({ blob: new Blob(), filename: 'document.pdf' }),
      }),
      MockProvider(HostFileExportService, {
        save: () => of({ kind: 'completed' as const }),
      }),
      MockProvider(UrlPreviewService, { preview: () => of(null) }),
      MockProvider(PrivacySettingsService, {
        linkPreviews: signal(true).asReadonly(),
        linkPreviewsInEncrypted: signal(false).asReadonly(),
      }),
    ],
  });
  const row = result.container.querySelector('.msg') as HTMLElement;
  const drawer = result.container.querySelector(
    '[data-testid="drawer-gesture-host"]',
  ) as HTMLElement;
  let capturedByDrawer = false;

  // jsdom has no pointer capture. Keep every production handler real and fake only the
  // browser boundary observed on the Android trace: once the drawer captures, the row gets
  // pointerleave and later events are retargeted to the drawer until capture is released.
  drawer.setPointerCapture = () => {
    if (capturedByDrawer) {
      return;
    }
    capturedByDrawer = true;
    row.dispatchEvent(touch('pointerleave', 0, 0, 0, false));
  };
  drawer.releasePointerCapture = () => {
    capturedByDrawer = false;
  };
  drawer.hasPointerCapture = () => capturedByDrawer;

  const dispatch = (type: string, x: number, y: number, at: number): void => {
    const target = capturedByDrawer ? drawer : row;
    target.dispatchEvent(touch(type, x, y, at));
  };

  return {
    host: result.fixture.componentInstance,
    down: (x, y, at = 0) => dispatch('pointerdown', x, y, at),
    move: (x, y, at) => dispatch('pointermove', x, y, at),
    up: (x, y, at) => dispatch('pointerup', x, y, at),
  };
}

describe('MessageRowComponent inside an open DrawerSwipeDirective', () => {
  beforeEach(() => {
    state.mobile = true;
    vi.stubGlobal('innerWidth', 400);
  });

  afterEach(() => {
    TestBed.inject(TrnDialogService).closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps Thread open when a stationary long press opens the message sheet', async () => {
    const gesture = await renderGesture();
    vi.useFakeTimers();

    gesture.down(100, 100);
    gesture.move(100.8, 100, 9);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    TestBed.tick();

    expect(gesture.host.longPresses).toBe(1);
    expect(TestBed.inject(TrnDialogService).hasOpen()).toBe(true);
    expect(document.body.textContent).toContain('Reply in thread');

    // A finger can keep moving after the sheet appears. That continuation belongs to the
    // overlay; it must not dismiss the Thread drawer underneath the new backdrop.
    gesture.move(220, 100, 750);
    gesture.up(220, 100, 800);

    expect(gesture.host.drawerEvents).toEqual([]);
    expect(TestBed.inject(TrnDialogService).hasOpen()).toBe(true);
  });

  it('lets a deliberate rightward drag cancel the press and close Thread', async () => {
    const gesture = await renderGesture();
    vi.useFakeTimers();

    gesture.down(100, 100);
    gesture.move(111, 100, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    gesture.up(220, 100, 600);

    expect(gesture.host.longPresses).toBe(0);
    expect(TestBed.inject(TrnDialogService).hasOpen()).toBe(false);
    expect(gesture.host.drawerEvents).toEqual(['closed']);
  });

  it('leaves a vertical drag to scrolling without closing Thread or firing the press', async () => {
    const gesture = await renderGesture();
    vi.useFakeTimers();

    gesture.down(100, 100);
    gesture.move(105, 113, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    gesture.up(220, 113, 600);

    expect(gesture.host.longPresses).toBe(0);
    expect(TestBed.inject(TrnDialogService).hasOpen()).toBe(false);
    expect(gesture.host.drawerEvents).toEqual([]);
  });
});
