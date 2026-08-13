import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerAttachmentStripComponent } from './composer-attachment-strip.component';

const png = () => new File(['x'], 'holiday.png', { type: 'image/png' });

describe('ComposerAttachmentStripComponent', () => {
  it('shows nothing while idle', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {},
    });

    expect(container.querySelector('[data-testid=upload-progress]')).toBeNull();
    expect(
      container.querySelector('[data-testid=composer-pending]'),
    ).toBeNull();
  });

  it('exposes an in-flight upload as a determinate bar with a percentage', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        uploadProgress: 0.42,
        uploadDeterminate: true,
        uploadPercent: 42,
      },
    });

    const wrapper = container.querySelector('[data-testid=upload-progress]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.textContent).toContain('42%');
    // helm/BrnProgress scales the fraction onto its 0–100 range.
    expect(
      Number(
        container
          .querySelector('trn-progress [role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ),
    ).toBeCloseTo(42, 5);
  });

  it('leaves the bar indeterminate and unlabelled before the first real fraction', async () => {
    // A metadata probe and a thumbnail upload come first; a pinned 0% reads as stalled.
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: { uploadProgress: 0, uploadDeterminate: false, uploadPercent: 0 },
    });

    expect(
      container.querySelector('[data-testid=upload-progress]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('trn-progress [role="progressbar"]')
        ?.getAttribute('aria-valuenow'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid=upload-progress]')?.textContent,
    ).not.toContain('%');
  });

  it('names a staged attachment and previews an image by its object URL', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: { pendingFile: png(), pendingPreview: 'blob:preview' },
    });

    expect(
      container.querySelector('[data-testid=composer-pending]')?.textContent,
    ).toContain('holiday.png');
    expect(
      container
        .querySelector<HTMLImageElement>('.composer__pending-thumb')
        ?.getAttribute('src'),
    ).toBe('blob:preview');
  });

  it('falls back to a paperclip when the staged file is not an image', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        pendingFile: new File(['x'], 'notes.pdf', { type: 'application/pdf' }),
        pendingPreview: null,
      },
    });

    expect(container.querySelector('.composer__pending-thumb')).toBeNull();
    expect(container.querySelector('.composer__pending-icon')).not.toBeNull();
  });

  it('asks the composer to drop the attachment when the × is pressed', async () => {
    const { fixture, container } = await render(
      ComposerAttachmentStripComponent,
      { inputs: { pendingFile: png(), pendingPreview: 'blob:preview' } },
    );
    let removed = 0;
    fixture.componentInstance.removePending.subscribe(() => removed++);

    container
      .querySelector<HTMLElement>('[data-testid=composer-pending-remove]')
      ?.click();

    expect(removed).toBe(1);
  });

  it('names its controls and announces progress for screen readers', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        uploadProgress: 0.5,
        uploadDeterminate: true,
        uploadPercent: 50,
        pendingFile: png(),
        pendingPreview: 'blob:preview',
      },
    });

    expect(
      container
        .querySelector('trn-progress [role="progressbar"]')
        ?.getAttribute('aria-label'),
    ).toBe('Uploading attachment');
    expect(
      container
        .querySelector('.composer__upload-label')
        ?.getAttribute('aria-live'),
    ).toBe('polite');
    expect(
      container
        .querySelector('[data-testid=composer-pending-remove]')
        ?.getAttribute('aria-label'),
    ).toBe('Remove attachment');
  });

  afterEach(() => TestBed.resetTestingModule());
});
