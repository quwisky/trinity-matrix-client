import { describe, expect, it, vi } from 'vitest';
import { downloadTextFile } from './download-text-file';

describe('downloadTextFile', () => {
  it('clicks an anchor carrying the content as a typed data URL', () => {
    const anchor = document.createElement('a');
    const click = vi.fn();
    anchor.click = click;
    const doc = {
      createElement: vi.fn().mockReturnValue(anchor),
    } as unknown as Document;

    downloadTextFile(doc, {
      name: 'trinity-settings-2026-01-02.json',
      mimeType: 'application/json',
      content: '{"version":1}',
    });

    expect(anchor.download).toBe('trinity-settings-2026-01-02.json');
    expect(anchor.href).toContain('data:application/json;charset=utf-8,');
    expect(decodeURIComponent(anchor.href)).toContain('{"version":1}');
    expect(click).toHaveBeenCalled();
  });

  // A raw `#` or `&` in the payload would truncate the document at that character.
  it('escapes characters a URL would otherwise swallow', () => {
    const anchor = document.createElement('a');
    anchor.click = vi.fn();
    const doc = {
      createElement: () => anchor,
    } as unknown as Document;

    downloadTextFile(doc, {
      name: 'keys.txt',
      mimeType: 'text/plain',
      content: 'a#b&c d',
    });

    expect(anchor.href).toContain('a%23b%26c%20d');
    expect(decodeURIComponent(anchor.href)).toContain('a#b&c d');
  });
});
