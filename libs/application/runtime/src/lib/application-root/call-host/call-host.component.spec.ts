import { signal } from '@angular/core';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import {
  CallService,
  CallStageService,
  type ActiveCall,
} from '@trinity/data-access/calls';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, Observable, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CallHostComponent } from './call-host.component';

const CALL: ActiveCall = {
  id: 1,
  roomId: '!call:hs',
  roomName: 'Design sync',
  accountId: '@me:hs',
  widgetUrl: 'trinity://app/element-call/index.html#?roomId=!call:hs',
  state: 'joined',
  joinedAt: 0,
};

function elementOf(
  width: number,
  height: number,
  top = 10,
  left = 20,
): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () =>
    ({ top, left, width, height }) as DOMRect;
  return element;
}

async function build(
  initial: ActiveCall | null = CALL,
  initialStage?: HTMLElement,
) {
  const activeCall = signal<ActiveCall | null>(initial);
  const attach = vi.fn(() => NEVER);
  const hangUp = vi.fn();
  let elapsedSubscriptions = 0;
  const elapsed = vi.fn(
    () =>
      new Observable<string>((subscriber) => {
        elapsedSubscriptions++;
        subscriber.next('0:05');
      }),
  );
  const participants = vi.fn(() => of(2));
  const navigate = vi.fn(() =>
    of({ kind: 'ready' as const, change: 'committed' as const }),
  );
  const result = await render(CallHostComponent, {
    providers: [
      provideTrnIcons(),
      MockProvider(CallService, {
        activeCall,
        attach,
        hangUp,
        elapsed,
        participants,
      }),
      MockProvider(WorkspaceNavigationService, { navigate }),
      {
        provide: CallStageService,
        useFactory: () => {
          const service = new CallStageService();
          if (initialStage) service.register(initialStage);
          return service;
        },
      },
    ],
  });
  const stage = result.fixture.debugElement.injector.get(CallStageService);
  const iframe = () =>
    (result.container as HTMLElement).querySelector('iframe');
  const strip = () => screen.queryByRole('region', { name: 'Call' });
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
    participants,
    stage,
    iframe,
    strip,
    update,
    elapsedSubscriptions: () => elapsedSubscriptions,
  };
}

describe('CallHostComponent', () => {
  it('renders no frame without a call', async () => {
    const { iframe } = await build(null);
    expect(iframe()).toBeNull();
  });

  it('lays the frame over a registered stage', async () => {
    const { stage, iframe, strip, update } = await build();
    stage.register(elementOf(600, 400));
    await update();

    expect(iframe()?.style.width).toBe('600px');
    expect(iframe()?.style.height).toBe('400px');
    expect(strip()).toBeNull();
  });

  it('subscribes to no call time on the stage', async () => {
    const { strip, update, elapsedSubscriptions } = await build(
      CALL,
      elementOf(600, 400),
    );
    await update();
    expect(strip()).toBeNull();
    expect(elapsedSubscriptions()).toBe(0);
  });

  it('follows the stage when an animation moves it', async () => {
    const { stage, iframe, update } = await build();
    const element = elementOf(600, 400);
    stage.register(element);
    await update();

    element.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 600, height: 400 }) as DOMRect;
    document.dispatchEvent(new Event('animationend'));
    await update();

    expect(iframe()?.style.left).toBe('0px');
    expect(iframe()?.style.top).toBe('0px');
  });

  it('lays the docked frame over the registered dock, without a strip', async () => {
    const { stage, iframe, strip, update } = await build();
    stage.claimDock();
    stage.registerDock(elementOf(264, 148, 300, 8));
    await update();

    expect(iframe()?.style.width).toBe('264px');
    expect(iframe()?.style.height).toBe('148px');
    expect(iframe()?.style.top).toBe('300px');
    expect(iframe()?.style.left).toBe('8px');
    expect(strip()).toBeNull();
  });

  it('hides the frame while the card is collapsed, without a strip', async () => {
    const { stage, iframe, strip, update } = await build();
    stage.claimDock();
    await update();

    expect(iframe()?.style.left).toBe('-10000px');
    expect(strip()).toBeNull();
  });

  it('shows the strip without a card', async () => {
    const { iframe, strip, participants } = await build();
    expect(strip()?.textContent).toContain('Call in Design sync · 2 · 0:05');
    expect(iframe()?.style.left).toBe('-10000px');
    expect(participants).toHaveBeenCalledWith(CALL.accountId, CALL.roomId);
  });

  // jsdom applies no component styles, so this pins the contract: the strip is the in-flow
  // row and only the frame and loading layer are fixed.
  it('keeps the strip in the page flow', async () => {
    const { strip } = await build();
    expect(strip()?.classList.contains('call-host__strip')).toBe(true);
    expect(strip()?.style.position).toBe('');
  });

  it('keeps one frame from stage to dock to collapsed', async () => {
    const { stage, iframe, update, attach } = await build();
    const release = stage.register(elementOf(600, 400));
    await update();
    const frame = iframe();

    release();
    stage.claimDock();
    const releaseDock = stage.registerDock(elementOf(264, 148));
    await update();
    expect(iframe()?.style.width).toBe('264px');

    releaseDock();
    await update();
    expect(iframe()?.style.left).toBe('-10000px');

    expect(iframe()).toBe(frame);
    expect(attach).toHaveBeenCalledExactlyOnceWith(frame);
  });

  it('hides the docked frame while the call ends', async () => {
    const { activeCall, iframe, strip, update, attach } = await build();
    const frame = iframe();

    activeCall.set({ ...CALL, state: 'ending' });
    await update();

    expect(strip()).toBeNull();
    expect(iframe()).toBe(frame);
    expect(iframe()?.style.left).toBe('-10000px');
    expect(attach).toHaveBeenCalledExactlyOnceWith(frame);
  });

  it('docks while the stage has no size', async () => {
    const { stage, strip, update } = await build();
    stage.register(elementOf(0, 0));
    await update();
    expect(strip()).toBeTruthy();
  });

  it('returns to the call room', async () => {
    const { navigate } = await build();
    screen.getByRole('button', { name: 'Return' }).click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'room',
        accountId: CALL.accountId,
        roomId: CALL.roomId,
      }),
    );
  });

  it('hangs up from the strip', async () => {
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

  it('leaves a failed call to the card when one is present', async () => {
    const { stage, strip, update } = await build({ ...CALL, state: 'failed' });
    stage.claimDock();
    await update();
    expect(strip()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops the frame and strip when the call goes away', async () => {
    const { activeCall, iframe, strip, update } = await build();
    activeCall.set(null);
    await update();
    expect(iframe()).toBeNull();
    expect(strip()).toBeNull();
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
