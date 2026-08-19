import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type StagedAttachment } from '../staged-attachment';
import { ComposerAttachmentStripComponent } from './composer-attachment-strip.component';

const png = (name = 'holiday.png') =>
  new File(['x'], name, { type: 'image/png' });

/** One staged item, in the shape the strip now takes. */
const item = (
  file: File,
  previewUrl: string | null = 'blob:preview',
  failed = false,
): StagedAttachment => ({
  id: `id-${file.name}`,
  file,
  previewUrl,
  failed,
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
        uploadProgress: { index: 1, total: 1, fraction: 0.42 },
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
      inputs: { uploadProgress: { index: 1, total: 1, fraction: 0 } },
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

  it('says which file of how many, in both the text and the accessible name', async () => {
    // A batch goes out one file at a time, so without the counter the bar sits at a fraction
    // that keeps restarting with nothing on screen to say why.
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        uploadProgress: { index: 2, total: 5, fraction: 0.5 },
        uploadLabel: 'holiday.png',
      },
    });

    expect(
      container.querySelector('[data-testid=upload-progress]')?.textContent,
    ).toContain('holiday.png (2 of 5)');
    expect(
      container
        .querySelector('trn-progress [role="progressbar"]')
        ?.getAttribute('aria-label'),
    ).toBe('Uploading holiday.png (2 of 5)');
  });

  it('drops the counter for a single file, where "1 of 1" is only noise', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        uploadProgress: { index: 1, total: 1, fraction: 0.5 },
        uploadLabel: 'holiday.png',
      },
    });

    expect(
      container.querySelector('[data-testid=upload-progress]')?.textContent,
    ).not.toContain('1 of 1');
  });

  it('puts the uploading file in the accessible name, not just the visible text', async () => {
    // The half a screen-reader user actually receives. Reverting this binding to the old
    // constant left the whole suite green, because the composer-side test reads the visible
    // span rather than the progressbar's name.
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        uploadProgress: { index: 1, total: 1, fraction: 0.5 },
        uploadLabel: 'holiday.png',
      },
    });

    expect(
      container
        .querySelector('trn-progress [role="progressbar"]')
        ?.getAttribute('aria-label'),
    ).toBe('Uploading holiday.png');
  });

  it('marks a failed row and offers it a retry, leaving the others alone', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        staged: [
          item(png('one.png')),
          item(png('bad.png'), 'blob:preview', true),
        ],
      },
    });

    const rows = container.querySelectorAll('[data-testid=composer-pending]');
    expect(
      rows[0]?.querySelector('[data-testid=composer-pending-failed]'),
    ).toBeNull();
    expect(
      rows[1]?.querySelector('[data-testid=composer-pending-failed]')
        ?.textContent,
    ).toContain('Not sent');
    // Only the failed row gets a retry — offering it on a file that has not been sent yet
    // would be an action with no meaning.
    expect(
      container.querySelectorAll('[data-testid=composer-pending-retry]'),
    ).toHaveLength(1);
    expect(
      rows[1]
        ?.querySelector('[data-testid=composer-pending-retry]')
        ?.getAttribute('aria-label'),
    ).toBe('Retry bad.png');
  });

  it('disables retry while a send is already going out', async () => {
    // Otherwise it looks pressable and does nothing: the composer refuses a second dispatch,
    // silently, which is the same dead-control shape the send button was fixed for twice.
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        staged: [item(png('bad.png'), 'blob:preview', true)],
        canRetry: false,
      },
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid=composer-pending-retry]',
      )?.disabled,
    ).toBe(true);
  });

  it('emits the failed attachment’s id when its retry is pressed', async () => {
    const retried: string[] = [];
    const { container, fixture } = await render(
      ComposerAttachmentStripComponent,
      {
        inputs: {
          staged: [item(png('bad.png'), 'blob:preview', true)],
        },
      },
    );
    fixture.componentInstance.retryStaged.subscribe((id) => retried.push(id));

    container
      .querySelector<HTMLElement>('[data-testid=composer-pending-retry]')
      ?.click();

    expect(retried).toEqual(['id-bad.png']);
  });

  it('names its controls and announces progress for screen readers', async () => {
    const { container } = await render(ComposerAttachmentStripComponent, {
      inputs: {
        uploadProgress: { index: 1, total: 1, fraction: 0.5 },
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
