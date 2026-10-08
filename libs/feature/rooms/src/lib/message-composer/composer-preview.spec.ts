import { describe, expect, it } from 'vitest';
import { composerPreview } from './composer-preview';

describe('composerPreview', () => {
  it('is empty for blank text', () => {
    expect(composerPreview('  \n ', [], true)).toEqual({
      html: '',
      rich: false,
    });
  });

  it('renders markdown through the timeline path', () => {
    const preview = composerPreview('**hi**', [], true);
    expect(preview.rich).toBe(true);
    expect(preview.html).toContain('<strong>hi</strong>');
  });

  it('conceals a spoiler only where the send path parses commands', () => {
    expect(composerPreview('/spoiler x', [], true).html).toContain(
      'data-mx-spoiler',
    );
    expect(composerPreview('/spoiler x', [], false).html).toContain(
      '/spoiler x',
    );
    expect(composerPreview('/spoiler x', [], false).html).not.toContain(
      'data-mx-spoiler',
    );
  });

  it('shows plain text escaped, and a bare link linkified', () => {
    expect(composerPreview('a < b', [], false)).toEqual(
      expect.objectContaining({ html: expect.stringContaining('&lt;') }),
    );
    const link = composerPreview('see https://example.org', [], false);
    expect(link.html).toContain('href="https://example.org');
  });
});
