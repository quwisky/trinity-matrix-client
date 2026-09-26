import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openChromeSession } from './webdriver-session.mts';

describe('Chrome WebDriver session ownership', () => {
  it('cleans up a failed driver startup without implicit executable downloads', async () => {
    await expect(
      openChromeSession({
        workspace: process.cwd(),
        artifact: 'http://127.0.0.1:1/',
        binaryPaths: {
          chrome: '/does/not/exist/chrome',
          chromedriver: '/does/not/exist/chromedriver',
        },
        closeTimeoutMs: 50,
      }),
    ).rejects.toThrow();
  });

  it('honours cancellation before it can create an owned process', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));
    await expect(
      openChromeSession({
        workspace: process.cwd(),
        artifact: 'http://127.0.0.1:1/',
        binaryPaths: { chrome: 'chrome', chromedriver: 'chromedriver' },
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled by test');
    expect(existsSync('/does/not/exist/chromedriver')).toBe(false);
  });
});
