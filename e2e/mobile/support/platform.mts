import { browser } from '@wdio/globals';

export type MobilePlatform = 'android' | 'ios';

export const mobilePlatform = (): MobilePlatform =>
  browser.isIOS ? 'ios' : 'android';

/**
 * A Mocha hook body that skips the suite (in `before`) or test (called first in `it`) on
 * the other platform and prints why, so a platform gap is named in the run log rather
 * than disappearing.
 */
export function onlyOn(
  platform: MobilePlatform,
  reason: string,
  current: () => MobilePlatform = mobilePlatform,
): (this: Mocha.Context) => void {
  return function skipOnOtherPlatform(this: Mocha.Context): void {
    const running = current();
    if (running === platform) return;
    console.log(
      `[mobile] skipped on ${running}: ${this.test?.fullTitle() ?? ''} — ${reason}`,
    );
    this.skip();
  };
}
