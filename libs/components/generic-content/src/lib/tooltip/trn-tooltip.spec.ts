import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { BrnTooltip } from '@spartan-ng/brain/tooltip';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRN_TOOLTIP_CONTENT_CLASSES,
  TRN_TOOLTIP_SVG_CLASSES,
  TrnTooltip,
} from './trn-tooltip';

@Component({
  imports: [TrnTooltip],
  template: `<button trnTooltip="Members" aria-label="Members">M</button>`,
})
class HostComponent {}

describe('TrnTooltip', () => {
  it('owns a semantic surface pair without retaining the inverted kit colours', () => {
    const content = TRN_TOOLTIP_CONTENT_CLASSES.split(/\s+/);
    const arrow = TRN_TOOLTIP_SVG_CLASSES.split(/\s+/);

    expect(content).toContain('bg-tooltip');
    expect(content).toContain('text-tooltip-foreground');
    expect(content).not.toContain('bg-foreground');
    expect(content).not.toContain('text-background');
    expect(arrow).toContain('bg-tooltip');
    expect(arrow).toContain('fill-tooltip');
    expect(arrow).not.toContain('bg-foreground');
    expect(arrow).not.toContain('fill-foreground');
  });

  it('publishes the message under our own name', async () => {
    // The defect control, and the reason this wrapper composes brain directly instead of the
    // kit directive: the message is published by the kit as `hlmTooltip`, and re-aliasing it
    // one level up throws NG0311. Reading it off the composed BrnTooltip proves the rename
    // actually took — a template that still said `hlmTooltip` would leave this undefined.
    const { fixture } = await render(HostComponent);
    // `.injector.get`, not `.componentInstance`: on a debug element the latter is the
    // COMPONENT that owns the element, not the directive applied to it.
    const brn = fixture.debugElement
      .query(By.directive(BrnTooltip))
      .injector.get(BrnTooltip);

    expect(brn.brnTooltip()).toBe('Members');
  });

  it('keeps the hover-intent delays that Brain 1.5 no longer defaults', async () => {
    // Brain 1.5 dropped its defaults to 0/0. At 0 a pointer sweeping across a message row's
    // hover toolbar opens a tooltip over the neighbouring action on every pass.
    const { fixture } = await render(HostComponent);
    const brn = fixture.debugElement
      .query(By.directive(BrnTooltip))
      .injector.get(BrnTooltip);

    expect(brn.showDelay()).toBe(150);
    expect(brn.hideDelay()).toBe(100);
  });

  it('decorates the host without replacing it', async () => {
    // 29 of 30 call sites put this on a button that already carries other directives, and
    // one puts it on a <trn-icon>. Anything that changed the host element would break both.
    const { container } = await render(HostComponent);
    const button = container.querySelector('button');

    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-label')).toBe('Members');
  });

  describe('focus', () => {
    async function focusWith(focusVisible: boolean, beforeFocus?: () => void) {
      vi.useFakeTimers();
      const { container } = await render(HostComponent);
      const button = container.querySelector('button') as HTMLButtonElement;
      // jsdom's :focus-visible is a heuristic that depends on earlier pointer events; stub it
      // so keyboard intent is deterministic, and defer to the real matcher for anything else.
      stubFocusVisible(button, focusVisible);
      if (beforeFocus) {
        beforeFocus();
        // FocusMonitor attributes focus to the last input for a moment only (1 ms after a
        // key, 650 ms after a touch). Let that lapse, as it has by the time a sheet closes, so
        // the focus below reaches Brain as 'program' and the input modality decides.
        await vi.advanceTimersByTimeAsync(700);
      }
      // CDK reports programmatic focus as 'program', which Brain treats as keyboard intent:
      // exactly what restoring focus to a row after a sheet closes looks like.
      button.focus();
      await vi.advanceTimersByTimeAsync(500);
      return document.querySelector('[role="tooltip"]');
    }

    afterEach(() => vi.useRealTimers());

    function stubFocusVisible(button: HTMLElement, focusVisible: boolean) {
      const real = button.matches.bind(button);
      vi.spyOn(button, 'matches').mockImplementation((selector) =>
        selector === ':focus-visible' ? focusVisible : real(selector),
      );
    }

    function touch() {
      document.dispatchEvent(new Event('touchstart', { bubbles: true }));
    }

    function pointer(
      button: HTMLElement,
      type: 'pointerenter' | 'pointerleave',
    ) {
      const event = new Event(type);
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      button.dispatchEvent(event);
    }

    it('keeps the tooltip when a click focuses the host within the show delay', async () => {
      vi.useFakeTimers();
      const { container } = await render(HostComponent);
      const button = container.querySelector('button') as HTMLButtonElement;
      stubFocusVisible(button, false);

      pointer(button, 'pointerenter');
      await vi.advanceTimersByTimeAsync(50);
      button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(500);

      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    });

    it('still opens on hover after focus was restored without a ring', async () => {
      expect(await focusWith(false)).toBeNull();
      const button = document.querySelector('button') as HTMLButtonElement;
      pointer(button, 'pointerenter');
      await vi.advanceTimersByTimeAsync(500);

      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    });

    it('does not open when focus arrives without focus-visible', async () => {
      expect(await focusWith(false)).toBeNull();
    });

    it('opens on keyboard-style focus-visible focus', async () => {
      expect(await focusWith(true)).not.toBeNull();
    });

    it('does not open when focus-visible focus follows a touch', async () => {
      // In Playwright on macOS WebKit a tap focuses nothing, so focus restored after it still
      // matches :focus-visible (#1216).
      expect(await focusWith(true, touch)).toBeNull();
    });

    it('opens on focus-visible focus once a key is pressed after a touch', async () => {
      expect(
        await focusWith(true, () => {
          touch();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        }),
      ).not.toBeNull();
    });
  });
});
