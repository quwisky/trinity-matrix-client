import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  MessageGestureSettingsService,
  TRINITY_SWIPE_ACTIONS,
  type SwipeAction,
} from '@trinity/platform-native';
import { MessageGesturesBlockComponent } from './message-gestures-block.component';

describe('MessageGesturesBlockComponent', () => {
  let messageSwipe: ReturnType<typeof signal<SwipeAction>>;
  let setMessageSwipe: Mock;

  beforeEach(() => {
    messageSwipe = signal<SwipeAction>('off');
    setMessageSwipe = vi.fn();
  });

  function renderBlock() {
    return render(MessageGesturesBlockComponent, {
      providers: [
        MockProvider(MessageGestureSettingsService, {
          messageSwipe,
          // An instance FIELD, so `MockProvider` cannot infer it — the component's
          // `swipeOptions` initializer reads it and would throw on undefined.
          swipeActions: TRINITY_SWIPE_ACTIONS,
          setMessageSwipe,
        }),
      ],
    });
  }

  it('renders the control with an accessible name', async () => {
    const { container } = await renderBlock();

    const select = container.querySelector(
      '[data-testid=message-swipe-select] [role=combobox]',
    );
    expect(select).not.toBeNull();
    const labelledBy = select?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(container.querySelector(`#${labelledBy}`)?.textContent).toContain(
      'Swipe action',
    );
  });

  it('shows the label of the stored direction, not its id', async () => {
    // Only the collapsed trigger is assertable here: the option list lives in a CDK overlay
    // jsdom never opens, which is what the e2e covers instead.
    messageSwipe.set('left');
    const { container } = await renderBlock();

    expect(
      container.querySelector('trn-select hlm-select-trigger')?.textContent,
    ).toContain('Left');
  });

  it('applies a registered direction', async () => {
    const { fixture } = await renderBlock();

    fixture.componentInstance.onMessageSwipeChange('right');

    expect(setMessageSwipe).toHaveBeenCalledWith('right');
  });

  it('refuses anything that is not one', async () => {
    // `valueChange` is typed `string | null | undefined`, so the guard is what stops an
    // unregistered id reaching the service and being persisted.
    const { fixture } = await renderBlock();

    fixture.componentInstance.onMessageSwipeChange('diagonal');
    fixture.componentInstance.onMessageSwipeChange(null);
    fixture.componentInstance.onMessageSwipeChange(undefined);

    expect(setMessageSwipe).not.toHaveBeenCalled();
  });

  it('offers exactly the registered directions, Off among them', () => {
    // Asserted against the registry rather than the rendered list, for the overlay reason
    // above. Off is named explicitly because it is a first-class choice, not the absence of
    // one — and it is the default, so it has to be offerable to be returned to.
    expect(TRINITY_SWIPE_ACTIONS.map((action) => action.id)).toEqual([
      'off',
      'left',
      'right',
    ]);
    expect(TRINITY_SWIPE_ACTIONS.map((action) => action.label)).toEqual([
      'Off',
      'Left',
      'Right',
    ]);
  });

  it('derives a harness hook for every option', async () => {
    const { fixture } = await renderBlock();

    expect(fixture.componentInstance.swipeOptions.map((o) => o.testId)).toEqual(
      ['message-swipe-off', 'message-swipe-left', 'message-swipe-right'],
    );
  });
});
