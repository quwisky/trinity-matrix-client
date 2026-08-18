import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerAttachmentStripComponent } from './composer-attachment-strip.component';

const png = () => new File(['x'], 'holiday.png', { type: 'image/png' });

/** One staged item, in the shape the strip now takes. */
const item = (file: File, previewUrl: string | null = 'blob:preview') => ({
  id: `id-${file.name}`,
  file,
  previewUrl,
});

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
      inputs: { staged: [item(png())] },
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
        staged: [
          item(new File(['x'], 'notes.pdf', { type: 'application/pdf' }), null),
        ],
      },
    });

    expect(container.querySelector('.composer__pending-thumb')).toBeNull();
    expect(container.querySelector('.composer__pending-icon')).not.toBeNull();
  });

  it('lists every staged attachment, in the order it will be sent', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        staged: [
          item(new File(['x'], 'one.png', { type: 'image/png' })),
          item(new File(['x'], 'two.png', { type: 'image/png' })),
          item(new File(['x'], 'three.png', { type: 'image/png' })),
        ],
      },
    });

    const rows = container.querySelectorAll('[data-testid=composer-pending]');
    expect(rows).toHaveLength(3);
    expect([...rows].map((row) => row.textContent?.trim())).toEqual([
      'one.png',
      'two.png',
      'three.png',
    ]);
  });

  it('names the attachment each × removes, and reports which one', async () => {
    // The id, not the index: the strip is re-rendered from a signal, and an index would
    // remove the wrong file the moment anything above it is dropped first.
    const { fixture, container } = await render(
      ComposerAttachmentStripComponent,
      {
        inputs: {
          staged: [
            item(new File(['x'], 'one.png', { type: 'image/png' })),
            item(new File(['x'], 'two.png', { type: 'image/png' })),
          ],
        },
      },
    );
    let removed: string | null = null;
    fixture.componentInstance.removeStaged.subscribe((id) => (removed = id));

    const buttons = container.querySelectorAll<HTMLElement>(
      '[data-testid=composer-pending-remove]',
    );
    expect(buttons[1]?.getAttribute('aria-label')).toBe('Remove two.png');
    buttons[1]?.click();

    expect(removed).toBe('id-two.png');
  });

  it('names its controls and announces progress for screen readers', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        uploadProgress: 0.5,
        uploadDeterminate: true,
        uploadPercent: 50,
        staged: [item(png())],
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
    // Named per file, not a generic "Remove attachment": with several staged, N identically
    // labelled buttons tell a screen-reader user nothing about which one they are on.
    expect(
      container
        .querySelector('[data-testid=composer-pending-remove]')
        ?.getAttribute('aria-label'),
    ).toBe('Remove holiday.png');
  });

  afterEach(() => TestBed.resetTestingModule());
});
