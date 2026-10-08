import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageSwipeDirective,
  type SwipeDirection,
} from './message-swipe.directive';

@Component({
  imports: [MessageSwipeDirective],
  template: `<div
    class="msg"
    [trnMessageSwipe]="direction()"
    [swipeEnabled]="enabled()"
    (swipe)="swiped = swiped + 1"
  ></div>`,
})
class HostComponent {
  readonly direction = signal<SwipeDirection>('right');
  readonly enabled = signal(true);
  readonly gesture = viewChild.required(MessageSwipeDirective);
  swiped = 0;
}

function touch(type: string, x: number, y = 100): PointerEvent {
  return new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    bubbles: true,
  });
}

describe('MessageSwipeDirective', () => {
  beforeEach(() => vi.stubGlobal('innerWidth', 1000));
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('.msg') as HTMLElement;
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      width: 400,
    } as DOMRect);
    return { host: fixture.componentInstance, el };
  }

  it('arms, tracks and emits once the drag passes a quarter of the row', () => {
    const { host, el } = setup();

    expect(host.gesture().arm(touch('pointerdown', 300))).toBe(true);
    host.gesture().track(touch('pointermove', 450));
    expect(el.style.getPropertyValue('--swipe-drag')).toBe('150px');
    host.gesture().release(touch('pointerup', 450));

    expect(host.swiped).toBe(1);
    expect(el.style.getPropertyValue('--swipe-drag')).toBe('');
  });

  it('does not arm while disabled or switched off', () => {
    const { host } = setup();

    host.enabled.set(false);
    TestBed.tick();
    expect(host.gesture().arm(touch('pointerdown', 300))).toBe(false);

    host.enabled.set(true);
    host.direction.set('off');
    TestBed.tick();
    expect(host.gesture().arm(touch('pointerdown', 300))).toBe(false);
  });

  it('cancel() puts the row back and forgets the drag', () => {
    const { host, el } = setup();

    host.gesture().arm(touch('pointerdown', 300));
    host.gesture().track(touch('pointermove', 450));
    host.gesture().cancel();
    host.gesture().release(touch('pointerup', 450));

    expect(host.swiped).toBe(0);
    expect(el.style.getPropertyValue('--swipe-drag')).toBe('');
  });
});
