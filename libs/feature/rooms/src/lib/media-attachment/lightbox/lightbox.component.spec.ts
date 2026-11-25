import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { TrnDialogRef } from '@trinity/components/overlay';
import { type PresentedMediaReference } from '@trinity/data-access/media';
import { describe, expect, it, vi } from 'vitest';
import { MediaSaveService } from '../media-save.service';
import { LightboxComponent } from './lightbox.component';

const media = {
  id: 'm',
  kind: 'image',
  filename: 'pic.png',
  mimeType: 'image/png',
} as PresentedMediaReference;

async function renderLightbox(saving = signal(false)) {
  const isSaving = vi.fn(
    (m: PresentedMediaReference) => m === media && saving(),
  );
  const saveMedia = vi.fn();
  const close = vi.fn();
  const view = await render(LightboxComponent, {
    inputs: { src: 'blob:full', filename: 'pic.png', media },
    providers: [
      { provide: TrnDialogRef, useValue: { close } },
      { provide: MediaSaveService, useValue: { save: saveMedia, isSaving } },
    ],
  });
  const button = () =>
    view.container.querySelector<HTMLButtonElement>(
      '[data-testid="lightbox-download"]',
    )!;
  return { ...view, saveMedia, close, saving, button };
}

describe('LightboxComponent download', () => {
  it('offers a named download button that saves the opened media', async () => {
    const { button, saveMedia, close } = await renderLightbox();

    expect(button().getAttribute('aria-label')).toBe('Download image');
    button().click();

    expect(saveMedia).toHaveBeenCalledWith(media);
    // The click must not bubble to the host's close-on-click.
    expect(close).not.toHaveBeenCalled();
  });

  it('is busy and inert while its own item is saving, without closing the viewer', async () => {
    const { button, fixture, saving, saveMedia, close } =
      await renderLightbox();
    expect(button().getAttribute('aria-disabled')).toBeNull();

    saving.set(true);
    fixture.componentInstance.media();
    fixture.detectChanges();
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(button().getAttribute('aria-busy')).toBe('true');

    button().click();
    expect(saveMedia).not.toHaveBeenCalled();
    // A tap during a save must not reach the host's close-on-click.
    expect(close).not.toHaveBeenCalled();
  });
});

describe('LightboxComponent touch', () => {
  const touch = (host: Element, type: string, init: PointerEventInit) =>
    host.dispatchEvent(
      new PointerEvent(type, {
        pointerType: 'touch',
        pointerId: 1,
        bubbles: true,
        ...init,
      }),
    );

  it('closes on a mouse click but a finger tap only toggles the controls', async () => {
    const { close, fixture } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;

    root.click();
    expect(close).toHaveBeenCalledTimes(1);

    touch(root, 'pointerdown', { clientX: 20, clientY: 20 });
    touch(root, 'pointerup', { clientX: 20, clientY: 20 });
    root.click();
    expect(close).toHaveBeenCalledTimes(1);
    fixture.detectChanges();
    expect(root.classList).toContain('lightbox--bare');
  });

  it('keeps the explicit close working for a finger', async () => {
    const { close, fixture } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    root
      .querySelector<HTMLButtonElement>('[data-testid="lightbox-close"]')!
      .click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  const matrix = (root: HTMLElement) => {
    const m = root
      .querySelector<HTMLImageElement>('.lightbox__image')!
      .style.transform.match(
        /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/,
      )!;
    return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
  };
  const sized = (root: HTMLElement, width: number, height: number) => {
    const img = root.querySelector<HTMLImageElement>('.lightbox__image')!;
    Object.defineProperty(img, 'clientWidth', {
      value: width,
      configurable: true,
    });
    Object.defineProperty(img, 'clientHeight', {
      value: height,
      configurable: true,
    });
  };
  const tapAt = (root: Element, id: number, x: number, y: number) => {
    touch(root, 'pointerdown', { pointerId: id, clientX: x, clientY: y });
    touch(root, 'pointerup', { pointerId: id, clientX: x, clientY: y });
  };

  it('brings hidden controls back on a key press or focus, without removing them', async () => {
    const { fixture } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    tapAt(root, 1, 20, 20);
    fixture.detectChanges();
    expect(root.classList).toContain('lightbox--bare');
    root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    fixture.detectChanges();
    expect(root.classList).not.toContain('lightbox--bare');

    tapAt(root, 1, 20, 20);
    fixture.detectChanges();
    expect(root.classList).toContain('lightbox--bare');
    root
      .querySelector<HTMLButtonElement>('[data-testid="lightbox-close"]')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    fixture.detectChanges();
    expect(root.classList).not.toContain('lightbox--bare');
  });

  it('keeps a click with no finger before it, such as an assistive activation', async () => {
    const { fixture, close } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    tapAt(root, 1, 20, 20);
    await new Promise((resolve) => setTimeout(resolve, 600));
    root.click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('carries on from the current view when one finger of a pinch is cancelled', async () => {
    const { fixture } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    sized(root, 400, 800);
    touch(root, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 0 });
    touch(root, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 0 });
    touch(root, 'pointermove', { pointerId: 2, clientX: 300, clientY: 0 });
    const pinched = matrix(root);
    expect(pinched.scale).toBeGreaterThan(1);

    touch(root, 'pointercancel', { pointerId: 2, clientX: 300, clientY: 0 });
    expect(matrix(root)).toEqual(pinched);
    touch(root, 'pointermove', { pointerId: 1, clientX: 100, clientY: 0 });
    // The remaining finger has not moved, so the image has not either.
    expect(matrix(root)).toEqual(pinched);
  });

  it('re-clamps a zoomed image when the viewer resizes', async () => {
    const { fixture } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    sized(root, 400, 800);
    tapAt(root, 1, 100, 0);
    tapAt(root, 1, 100, 0);
    const zoomed = matrix(root);
    expect(zoomed.scale).toBeGreaterThan(1);
    expect(zoomed.x).toBeLessThan(-100);

    sized(root, 100, 200);
    window.dispatchEvent(new Event('resize'));
    const refit = matrix(root);
    expect(Math.abs(refit.x)).toBeLessThanOrEqual(
      ((refit.scale - 1) * 100) / 2,
    );
  });

  it('does not dismiss from a release after the finger came back up', async () => {
    const { fixture, close } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    touch(root, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 100 });
    touch(root, 'pointermove', { pointerId: 1, clientX: 0, clientY: 400 });
    touch(root, 'pointermove', { pointerId: 1, clientX: 0, clientY: 90 });
    touch(root, 'pointerup', { pointerId: 1, clientX: 0, clientY: 90 });
    expect(close).not.toHaveBeenCalled();
    expect(matrix(root).y).toBe(0);
  });

  it('moves focus off a control before a tap hides it, so Enter cannot act unseen', async () => {
    const { fixture } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    const closeButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="lightbox-close"]',
    )!;
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);

    tapAt(root, 1, 20, 20);
    fixture.detectChanges();
    expect(root.classList).toContain('lightbox--bare');
    expect(document.activeElement).not.toBe(closeButton);
  });
});

describe('LightboxComponent zoom', () => {
  const parts = (root: HTMLElement) => {
    const image = root.querySelector<HTMLImageElement>('.lightbox__image')!;
    const button = (id: string) =>
      root.querySelector<HTMLButtonElement>(`[data-testid="lightbox-${id}"]`)!;
    const scale = () =>
      Number(/scale\(([\d.]+)\)/.exec(image.style.transform)?.[1] ?? 1);
    return { image, button, scale };
  };
  const mouse = (target: Element, type: string, x: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerType: 'mouse',
        pointerId: 1,
        clientX: x,
        clientY: 0,
        bubbles: true,
      }),
    );
  // From the document: after a click, focus is on the dialog around the viewer, not inside it.
  const key = (_root: Element, value: string) =>
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true }),
    );

  it('zooms in on a click on the image and closes on a click on the matte', async () => {
    const { fixture, close } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    const { image, scale } = parts(root);
    image.click();
    expect(scale()).toBe(1.5);
    expect(close).not.toHaveBeenCalled();
    root.click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('goes back to fit on a click at the maximum', async () => {
    const { fixture } = await renderLightbox();
    const { image, scale } = parts(fixture.nativeElement);
    for (let i = 0; i < 4; i++) image.click();
    expect(scale()).toBe(4);
    image.click();
    expect(scale()).toBe(1);
  });

  it('zooms on the wheel and keeps it from the page', async () => {
    const { fixture } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    const wheel = new WheelEvent('wheel', {
      deltaY: -200,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    parts(root).image.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(parts(root).scale()).toBeGreaterThan(1);
  });

  it('zooms with + and - and resets with 0', async () => {
    const { fixture } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    const { scale } = parts(root);
    key(root, '+');
    expect(scale()).toBe(1.5);
    key(root, '-');
    expect(scale()).toBe(1);
    key(root, '=');
    key(root, '+');
    key(root, '0');
    expect(scale()).toBe(1);
  });

  it('steps with the zoom buttons and marks them at their limits', async () => {
    const { fixture, close } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    const { button, scale } = parts(root);
    fixture.detectChanges();
    expect(button('zoom-out').getAttribute('aria-disabled')).toBe('true');
    button('zoom-in').click();
    fixture.detectChanges();
    expect(scale()).toBe(1.5);
    expect(close).not.toHaveBeenCalled();
    expect(button('zoom-out').getAttribute('aria-disabled')).toBeNull();
    for (let i = 0; i < 4; i++) button('zoom-in').click();
    fixture.detectChanges();
    expect(scale()).toBe(4);
    expect(button('zoom-in').getAttribute('aria-disabled')).toBe('true');
    button('zoom-in').click();
    expect(scale()).toBe(4);
  });

  it('pans a zoomed image with a mouse drag without zooming or closing', async () => {
    const { fixture, close } = await renderLightbox();
    const root = fixture.nativeElement as HTMLElement;
    const { image, button, scale } = parts(root);
    button('zoom-in').click();
    mouse(image, 'pointerdown', 0);
    mouse(image, 'pointermove', 30);
    mouse(image, 'pointerup', 30);
    image.click();
    expect(scale()).toBe(1.5);
    expect(close).not.toHaveBeenCalled();
  });
});
