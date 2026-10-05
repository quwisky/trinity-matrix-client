import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/user-data') },
}));

import { readWindowPrefs, writeWindowPrefs } from './window-prefs';

const io = (read: () => string) => ({
  readFile: vi.fn(read),
  writeFile: vi.fn(),
  path: '/user-data/window-prefs.json',
});

describe('readWindowPrefs', () => {
  it('reads a missing file as the default', () => {
    const missing = io(() => {
      throw new Error('ENOENT');
    });
    expect(readWindowPrefs(missing)).toEqual({ systemTitleBar: false });
  });

  it('reads corrupt JSON as the default', () => {
    expect(readWindowPrefs(io(() => '{nope'))).toEqual({
      systemTitleBar: false,
    });
  });

  it('reads a boolean systemTitleBar and rejects other values', () => {
    expect(readWindowPrefs(io(() => '{"systemTitleBar":true}'))).toEqual({
      systemTitleBar: true,
    });
    expect(readWindowPrefs(io(() => '{"systemTitleBar":"yes"}'))).toEqual({
      systemTitleBar: false,
    });
    expect(readWindowPrefs(io(() => 'null'))).toEqual({
      systemTitleBar: false,
    });
  });
});

describe('writeWindowPrefs', () => {
  it('writes the prefs as JSON to the userData path', () => {
    const fake = io(() => '');
    writeWindowPrefs({ systemTitleBar: true }, fake);
    expect(fake.writeFile).toHaveBeenCalledWith(
      '/user-data/window-prefs.json',
      '{"systemTitleBar":true}',
    );
  });
});
