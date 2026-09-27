import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceBrowserBackService } from './workspace-browser-back.service';
import { WorkspaceNavigationService } from './workspace-navigation.service';
import type { WorkspaceView } from './workspace-navigation.models';
import type { WorkspaceConversationSurface } from './workspace-surface.models';

const ALICE = '@alice:example.org';
const ROOM = '!room:example.org';
const CONVERSATION: WorkspaceConversationSurface = {
  kind: 'conversation',
  accountId: ALICE,
  roomId: ROOM,
};

function setup(options: {
  readonly compact: boolean;
  readonly view?: Partial<WorkspaceView>;
}) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === BELOW_MD_QUERY && options.compact,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  const view = signal<WorkspaceView>({
    accountId: ALICE,
    scope: { kind: 'rooms' },
    roomId: ROOM,
    pane: 'conversation',
    ...options.view,
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: WorkspaceNavigationService, useValue: { view } },
    ],
  });
  return TestBed.inject(WorkspaceBrowserBackService);
}

afterEach(() => TestBed.resetTestingModule());

describe('WorkspaceBrowserBackService', () => {
  it("redirects a traversal leaving the compact Conversation to its Room's list pane", () => {
    const service = setup({ compact: true });

    expect(service.traversalRedirect(CONVERSATION)).toBe(
      `/rooms/${encodeRoomSegment(ROOM)}?account=${ALICE}&pane=list&view=rooms`,
    );
  });

  it('follows browser history once the live viewport is wide', () => {
    const service = setup({ compact: false });

    expect(service.traversalRedirect(CONVERSATION)).toBeNull();
  });

  it('follows browser history for a Conversation that is no longer open', () => {
    expect(
      setup({ compact: true, view: { pane: 'list' } }).traversalRedirect(
        CONVERSATION,
      ),
    ).toBeNull();
    TestBed.resetTestingModule();
    expect(
      setup({
        compact: true,
        view: { roomId: '!other:example.org' },
      }).traversalRedirect(CONVERSATION),
    ).toBeNull();
  });
});
