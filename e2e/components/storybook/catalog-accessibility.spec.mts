import { expect, test, type Page } from '@playwright/test';
import { formatAxeResults, runAxe } from './catalog-accessibility.mts';
import {
  DEFAULT_STORYBOOK_THEME_PREVIEW,
  storybookThemeGlobals,
} from './theme-preview.mts';

const OVERLAY_CATALOG =
  '/iframe.html?id=components-overlay-recipes--complete-catalog&viewMode=story';

interface AxeRaceEvent {
  readonly id: number;
  readonly stack?: string;
  readonly type: 'assign' | 'done' | 'reject' | 'run' | 'throw';
}

interface StorybookAxeAssetGate {
  readonly requested: Promise<void>;
  release(): void;
}

interface StorybookAxeRace {
  readonly page: Page;
  injectedInstanceId(): number | undefined;
}

interface AxeRaceRuns {
  readonly helper: number;
  readonly storybook: number;
}

async function installAxeRaceInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      __trinityAxeEvents: AxeRaceEvent[];
      __trinityAxeIdentity(value: object): number;
    };
    browserWindow.__trinityAxeEvents = [];
    const identities = new WeakMap<object, number>();
    const wrapped = new WeakSet<object>();
    let current: {
      run: (...arguments_: unknown[]) => unknown;
    } | null = null;
    let sequence = 0;
    const identity = (value: object): number => {
      const existing = identities.get(value);
      if (existing !== undefined) return existing;
      const id = ++sequence;
      identities.set(value, id);
      return id;
    };
    browserWindow.__trinityAxeIdentity = identity;
    Object.defineProperty(window, 'axe', {
      configurable: true,
      get: () => current,
      set: (value: { run: (...arguments_: unknown[]) => unknown }) => {
        current = value;
        const id = identity(value);
        browserWindow.__trinityAxeEvents.push({ type: 'assign', id });
        if (wrapped.has(value)) return;
        wrapped.add(value);
        let run = value.run;
        Object.defineProperty(value, 'run', {
          configurable: true,
          get: () => run,
          set: (nextRun: (...arguments_: unknown[]) => unknown) => {
            run = function (this: unknown, ...arguments_: unknown[]) {
              browserWindow.__trinityAxeEvents.push({
                type: 'run',
                id,
                stack: new Error().stack,
              });
              try {
                const result = nextRun.apply(this, arguments_);
                if (result instanceof Promise) {
                  void result.then(
                    () =>
                      browserWindow.__trinityAxeEvents.push({
                        type: 'done',
                        id,
                      }),
                    () =>
                      browserWindow.__trinityAxeEvents.push({
                        type: 'reject',
                        id,
                      }),
                  );
                }
                return result;
              } catch (error) {
                browserWindow.__trinityAxeEvents.push({ type: 'throw', id });
                throw error;
              }
            };
          },
        });
        value.run = value.run;
      },
    });
  });
}

async function deferStorybookAxeAsset(
  page: Page,
): Promise<StorybookAxeAssetGate> {
  let markRequested: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  let continueRequest: () => void;
  const released = new Promise<void>((resolve) => {
    continueRequest = resolve;
  });
  let isReleased = false;
  await page.route('**/assets/axe-*.js', async (route) => {
    markRequested();
    await released;
    await route.continue();
  });
  return {
    requested,
    release: () => {
      if (isReleased) return;
      isReleased = true;
      continueRequest();
    },
  };
}

async function waitForStorybookAxeRun(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const events = (
      window as typeof window & { __trinityAxeEvents: AxeRaceEvent[] }
    ).__trinityAxeEvents;
    return events.some(
      (event) => event.type === 'run' && event.stack?.includes('/assets/'),
    );
  });
}

/**
 * Release Storybook's deferred addon scan only after this helper has injected. The
 * old helper then read the replaced global; the fixed helper retains its handle.
 */
function pageDuringStorybookAxeRun(
  page: Page,
  gate: StorybookAxeAssetGate,
): StorybookAxeRace {
  let injectedInstance: number | undefined;
  return {
    page: new Proxy(page, {
      get(target, property, receiver) {
        if (property === 'addScriptTag') {
          return async (options: { readonly content: string }) => {
            const result = await target.addScriptTag(options);
            gate.release();
            await waitForStorybookAxeRun(target);
            return result;
          };
        }
        if (property === 'evaluateHandle') {
          return async (expression: string) => {
            const result = await target.evaluateHandle(expression);
            injectedInstance = await result.evaluate((value) => {
              if (typeof value !== 'object' || value === null) {
                throw new Error('Axe injection did not return an object.');
              }
              return (
                window as typeof window & {
                  __trinityAxeIdentity(instance: object): number;
                }
              ).__trinityAxeIdentity(value);
            });
            gate.release();
            await waitForStorybookAxeRun(target);
            return result;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Page,
    injectedInstanceId: () => injectedInstance,
  };
}

async function axeRaceEvents(page: Page): Promise<readonly AxeRaceEvent[]> {
  return page.evaluate(
    () =>
      (window as typeof window & { __trinityAxeEvents: AxeRaceEvent[] })
        .__trinityAxeEvents,
  );
}

async function waitForAxeRaceRuns(
  page: Page,
  helper: number | undefined,
): Promise<AxeRaceRuns> {
  if (helper === undefined) {
    throw new Error(
      'Axe helper injection did not record an instance identity.',
    );
  }
  await page.waitForFunction((helperId) => {
    const events = (
      window as typeof window & { __trinityAxeEvents: AxeRaceEvent[] }
    ).__trinityAxeEvents;
    const storybook = events.find(
      (event) => event.type === 'run' && event.stack?.includes('/assets/'),
    );
    const helperRun = events.find(
      (event) => event.type === 'run' && event.id === helperId,
    );
    if (storybook === undefined || helperRun === undefined) return false;
    return { helper: helperRun.id, storybook: storybook.id };
  }, helper);
  const events = await axeRaceEvents(page);
  const storybook = events.find(
    (event) => event.type === 'run' && event.stack?.includes('/assets/'),
  );
  if (storybook === undefined) {
    throw new Error('Storybook did not record its Axe scan.');
  }
  return { helper, storybook: storybook.id };
}

async function waitForSuccessfulAxeRuns(
  page: Page,
  runs: AxeRaceRuns,
): Promise<readonly AxeRaceEvent[]> {
  await page.waitForFunction(
    (ids) => {
      const events = (
        window as typeof window & { __trinityAxeEvents: AxeRaceEvent[] }
      ).__trinityAxeEvents;
      for (const id of ids) {
        const failed = events.find(
          (event) =>
            event.id === id &&
            (event.type === 'reject' || event.type === 'throw'),
        );
        if (failed !== undefined) {
          throw new Error(`Axe scan ${id} ${failed.type}.`);
        }
      }
      return ids.every((id) =>
        events.some((event) => event.id === id && event.type === 'done'),
      );
    },
    [runs.helper, runs.storybook],
  );
  return axeRaceEvents(page);
}

test('Axe catalog scans keep their injected instance while Storybook scans', async ({
  page,
}) => {
  await installAxeRaceInstrumentation(page);
  const gate = await deferStorybookAxeAsset(page);
  try {
    await page.goto(
      `${OVERLAY_CATALOG}&globals=${storybookThemeGlobals(DEFAULT_STORYBOOK_THEME_PREVIEW)}`,
    );
    await expect(page.getByTestId('complete-overlay-catalog')).toBeVisible();
    await gate.requested;

    const race = pageDuringStorybookAxeRun(page, gate);
    const scan = await runAxe(race.page);
    expect(formatAxeResults(scan.violations)).toEqual([]);
    expect(formatAxeResults(scan.incomplete)).toEqual([]);

    const runs = await waitForAxeRaceRuns(page, race.injectedInstanceId());
    const events = await waitForSuccessfulAxeRuns(page, runs);
    const injectedInstance = race.injectedInstanceId();
    expect(injectedInstance).toBe(runs.helper);
    expect(injectedInstance).toBeLessThan(runs.storybook);
    expect(
      events.filter(
        (event) => event.type === 'done' && event.id === runs.storybook,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.type === 'done' && event.id === runs.helper,
      ),
    ).toHaveLength(1);
  } finally {
    gate.release();
    await page.unroute('**/assets/axe-*.js');
  }
});
