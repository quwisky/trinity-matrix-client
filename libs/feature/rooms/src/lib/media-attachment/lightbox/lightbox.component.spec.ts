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
  const saveMedia = vi.fn();
  const close = vi.fn();
  const view = await render(LightboxComponent, {
    inputs: { src: 'blob:full', filename: 'pic.png', media },
    providers: [
      { provide: TrnDialogRef, useValue: { close } },
      { provide: MediaSaveService, useValue: { save: saveMedia, saving } },
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

  it('is disabled and busy while a save is in flight', async () => {
    const { button, fixture, saving } = await renderLightbox();
    expect(button().disabled).toBe(false);

    saving.set(true);
    fixture.detectChanges();

    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
  });
});
