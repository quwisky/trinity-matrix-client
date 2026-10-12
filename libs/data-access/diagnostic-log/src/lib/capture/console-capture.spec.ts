import { describe, expect, it, vi } from 'vitest';
import { installConsoleCapture } from './console-capture';

function fakeConsole() {
  const warn = vi.fn();
  const error = vi.fn();
  return { target: { warn, error } as unknown as Console, warn, error };
}

describe('installConsoleCapture', () => {
  it('records every warning and error and still passes it through', () => {
    const { target, warn, error } = fakeConsole();
    const write = vi.fn();
    installConsoleCapture(target, write);

    target.warn('careful', 1);
    target.error('broken');

    expect(write).toHaveBeenNthCalledWith(1, 'warn', ['careful', 1]);
    expect(write).toHaveBeenNthCalledWith(2, 'error', ['broken']);
    expect(warn).toHaveBeenCalledWith('careful', 1);
    expect(error).toHaveBeenCalledWith('broken');
  });

  it('keeps the console working when the writer throws', () => {
    const { target, warn } = fakeConsole();
    installConsoleCapture(target, () => {
      throw new Error('capture failed');
    });

    expect(() => target.warn('still shown')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('still shown');
  });

  it('gives the original methods back, unless something replaced them since', () => {
    const { target, warn, error } = fakeConsole();
    const uninstall = installConsoleCapture(target, vi.fn());
    const later = vi.fn();
    target.error = later;

    uninstall();

    expect(target.warn).toBe(warn);
    expect(target.error).toBe(later);
    expect(error).not.toHaveBeenCalled();
  });
});
