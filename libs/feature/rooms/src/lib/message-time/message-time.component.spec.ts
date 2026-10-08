import { render } from '@trinity/testing';
import { MessageTimeComponent } from './message-time.component';

const TS = Date.UTC(2026, 9, 8, 12, 30);

function pointerenter(pointerType: string): PointerEvent {
  return new PointerEvent('pointerenter', { pointerType });
}

describe('MessageTimeComponent', () => {
  it('renders the gutter variant as a <time> with the short time', async () => {
    const { container } = await render(MessageTimeComponent, {
      inputs: { timestamp: TS, armed: false, variant: 'gutter' },
    });

    const time = container.querySelector('time.msg__gutter');
    expect(time?.getAttribute('datetime')).toBe(new Date(TS).toISOString());
    expect(time?.textContent?.trim()).not.toBe('');
  });

  it('renders the head variant under its own class', async () => {
    const { container } = await render(MessageTimeComponent, {
      inputs: { timestamp: TS, armed: false, variant: 'head' },
    });

    expect(container.querySelector('time.msg__time')).toBeTruthy();
    expect(container.querySelector('.msg__gutter')).toBeNull();
  });

  it('falls back to a plain span when the timestamp is unusable', async () => {
    const { container } = await render(MessageTimeComponent, {
      inputs: { timestamp: 0, armed: false, variant: 'head' },
    });

    expect(container.querySelector('time')).toBeNull();
    expect(container.querySelector('span.msg__time')).toBeTruthy();
  });

  it('asks to be armed when a mouse or pen enters, not a finger', async () => {
    const { container, fixture } = await render(MessageTimeComponent, {
      inputs: { timestamp: TS, armed: false, variant: 'head' },
    });
    const arm = vi.fn();
    fixture.componentInstance.arm.subscribe(arm);
    const time = container.querySelector('time') as HTMLElement;

    time.dispatchEvent(pointerenter('touch'));
    expect(arm).not.toHaveBeenCalled();

    time.dispatchEvent(pointerenter('mouse'));
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('hands the tooltip the entry it missed once armed under the pointer', async () => {
    const { container, fixture } = await render(MessageTimeComponent, {
      inputs: { timestamp: TS, armed: false, variant: 'head' },
    });
    const entered = vi.fn();
    container.addEventListener('pointerenter', entered, true);

    (container.querySelector('time') as HTMLElement).dispatchEvent(
      pointerenter('mouse'),
    );
    entered.mockClear();
    fixture.componentRef.setInput('armed', true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(entered).toHaveBeenCalledTimes(1);
    expect((entered.mock.calls[0][0] as PointerEvent).pointerType).toBe(
      'mouse',
    );
  });
});
