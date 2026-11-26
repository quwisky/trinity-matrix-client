import { signal } from '@angular/core';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import {
  CallService,
  CallStageService,
  type ActiveCall,
} from '@trinity/data-access/calls';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CallHostComponent } from './call-host.component';

const CALL: ActiveCall = {
  id: 1,
  roomId: '!call:hs',
  accountId: '@me:hs',
  widgetUrl: 'trinity://app/element-call/index.html#?roomId=!call:hs',
  state: 'joined',
};

function stageOf(width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () =>
    ({ top: 10, left: 20, width, height }) as DOMRect;
  return element;
}

async function build(initial: ActiveCall | null = CALL) {
  const activeCall = signal<ActiveCall | null>(initial);
  const attach = vi.fn(() => NEVER);
  const hangUp = vi.fn();
  const navigate = vi.fn(() =>
    of({ kind: 'ready' as const, change: 'committed' as const }),
  );
  const result = await render(CallHostComponent, {
    providers: [
      MockProvider(CallService, { activeCall, attach, hangUp }),
      MockProvider(WorkspaceNavigationService, { navigate }),
    ],
  });
  const stage = result.fixture.debugElement.injector.get(CallStageService);
  const iframe = () =>
    (result.container as HTMLElement).querySelector('iframe');
  const update = async () => {
    result.fixture.detectChanges();
    await result.fixture.whenStable();
  };
  return {
    ...result,
    activeCall,
    attach,
    hangUp,
    navigate,
    stage,
    iframe,
    update,
  };
}

describe('CallHostComponent', () => {
  it('renders no frame without a call', async () => {
    const { iframe } = await build(null);
    expect(iframe()).toBeNull();
  });

  it('lays the frame over a registered stage', async () => {
    const { stage, iframe, update } = await build();
    stage.register(stageOf(600, 400));
    await update();

    expect(iframe()?.style.width).toBe('600px');
    expect(iframe()?.style.height).toBe('400px');
    expect(screen.queryByRole('region', { name: 'Call' })).toBeNull();
  });

  it('docks the same frame when the stage goes away', async () => {
    const { stage, iframe, update, attach } = await build();
    const release = stage.register(stageOf(600, 400));
    await update();
    const frame = iframe();

    release();
    await update();

    const dock = screen.getByRole('region', { name: 'Call' });
    expect(dock.textContent).toContain('Call in progress');
    expect(iframe()).toBe(frame);
    expect(attach).toHaveBeenCalledExactlyOnceWith(frame);
  });

  it('docks while the stage has no size', async () => {
    const { stage, update } = await build();
    stage.register(stageOf(0, 0));
    await update();
    expect(screen.getByRole('region', { name: 'Call' })).toBeTruthy();
  });

  it('returns to the call room', async () => {
    const { navigate } = await build();
    screen.getByRole('button', { name: 'Return to call' }).click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'room',
        accountId: CALL.accountId,
        roomId: CALL.roomId,
      }),
    );
  });

  it('hangs up from the dock', async () => {
    const { hangUp } = await build();
    screen.getByRole('button', { name: 'Hang up' }).click();
    expect(hangUp).toHaveBeenCalledOnce();
  });

  it('says when the call could not start and closes it', async () => {
    const { hangUp } = await build({ ...CALL, state: 'failed' });
    expect(screen.getByRole('alert').textContent).toContain(
      'The call could not start',
    );
    screen.getByRole('button', { name: 'Close' }).click();
    expect(hangUp).toHaveBeenCalledOnce();
  });

  it('drops the frame and dock when the call goes away', async () => {
    const { activeCall, iframe, update } = await build();
    activeCall.set(null);
    await update();
    expect(iframe()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Call' })).toBeNull();
  });

  it('gives a new call its own frame', async () => {
    const { activeCall, iframe, update, attach } = await build();
    const first = iframe();

    activeCall.set({ ...CALL, id: 2 });
    await update();

    expect(iframe()).not.toBe(first);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenLastCalledWith(iframe());
  });
});
