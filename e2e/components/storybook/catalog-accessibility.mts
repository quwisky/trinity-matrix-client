import axe from 'axe-core';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  contrastRatio,
  measureContrast,
  measureLocatorContrast,
  type Srgb,
} from '../../browser/support/contrast.mts';
import { renderedColour } from './recipe-appearance.mts';

export const DISABLED_READABILITY = 2;

interface AxeNodeResult {
  readonly html: string;
  readonly target: readonly (string | readonly string[])[];
}

interface AxeRuleResult {
  readonly help: string;
  readonly helpUrl: string;
  readonly id: string;
  readonly nodes: readonly AxeNodeResult[];
}

interface AxeScan {
  readonly incomplete: readonly AxeRuleResult[];
  readonly violations: readonly AxeRuleResult[];
}

type ColourSource = 'backgroundColor' | 'borderColor' | 'color' | `--${string}`;

function composite(foreground: Srgb, background: Srgb, opacity: number): Srgb {
  const channel = (ink: number, surface: number) =>
    Math.round(ink * opacity + surface * (1 - opacity));
  return {
    r: channel(foreground.r, background.r),
    g: channel(foreground.g, background.g),
    b: channel(foreground.b, background.b),
  };
}

/** A rule result inside the page, where `elementRef` adds each node's element. */
interface AxeBrowserRuleResult extends Omit<AxeRuleResult, 'nodes'> {
  readonly nodes: readonly (AxeNodeResult & { readonly element?: Element })[];
}

interface AxeBrowserApi {
  configure(config: {
    readonly rules: readonly {
      readonly enabled: boolean;
      readonly id: string;
    }[];
  }): void;
  run(
    context: Element | AxeContext,
    options: { readonly elementRef: boolean },
  ): Promise<{
    readonly incomplete: readonly AxeBrowserRuleResult[];
    readonly violations: readonly AxeBrowserRuleResult[];
  }>;
}

interface AxeContext {
  readonly exclude: readonly (readonly string[])[];
  readonly include: readonly (readonly string[])[];
}

/** One Axe rule waived for one third-party element that Trinity renders but cannot change. */
interface AxeRuleWaiver {
  readonly rule: string;
  readonly selector: string;
}

/**
 * Third-party DOM waivers. Each one drops a single rule's results for exactly the matched
 * elements; every other rule still scans them, and Trinity's own elements are never waived.
 */
const THIRD_PARTY_RULE_WAIVERS: readonly AxeRuleWaiver[] = [
  {
    // @ctrl/ngx-emoji-mart names each native emoji button "<glyph>, <short names>"
    // (aria-label="👍, +1, thumbsup") around the glyph alone. The glyph is part of the
    // name, but Axe cannot judge an emoji-only visible label and reports every button as
    // needing review. The library has no way to name its buttons differently.
    rule: 'label-content-name-mismatch',
    selector: 'button.emoji-mart-emoji',
  },
];

export async function runAxe(
  page: Page,
  excludedSelectors: readonly string[] = [],
): Promise<AxeScan> {
  // Storybook's a11y addon dynamically imports Axe after a story renders. Keep the
  // injected object instead of reading window.axe in a later browser call: the addon
  // may replace that global and begin its own scan in between.
  const browserAxe = await page.evaluateHandle<AxeBrowserApi>(
    `${axe.source}; window.axe`,
  );
  try {
    return await browserAxe.evaluate(
      async (instance, { selectors, waivers }) => {
        // Story canvases are fragments, so an application-level landmark is not required.
        instance.configure({ rules: [{ id: 'region', enabled: false }] });
        const context =
          selectors.length === 0
            ? document.body
            : {
                include: [['body']],
                exclude: selectors.map((selector) => [selector]),
              };
        const scan = await instance.run(context, { elementRef: true });
        // Drop waived nodes, then the element references, which cannot leave the page.
        const kept = (results: readonly AxeBrowserRuleResult[]) =>
          results
            .map((result) => ({
              help: result.help,
              helpUrl: result.helpUrl,
              id: result.id,
              nodes: result.nodes
                .filter(
                  ({ element }) =>
                    !waivers.some(
                      (waiver) =>
                        waiver.rule === result.id &&
                        element?.matches(waiver.selector),
                    ),
                )
                .map(({ html, target }) => ({ html, target })),
            }))
            .filter((result) => result.nodes.length > 0);
        return {
          incomplete: kept(scan.incomplete),
          violations: kept(scan.violations),
        };
      },
      { selectors: excludedSelectors, waivers: THIRD_PARTY_RULE_WAIVERS },
    );
  } finally {
    await browserAxe.dispose();
  }
}

export function formatAxeResults(results: readonly AxeRuleResult[]): string[] {
  return results.flatMap((result) =>
    result.nodes.map(
      (node) =>
        `${result.id}: ${result.help} at ${JSON.stringify(node.target)} (${node.html}) — ${result.helpUrl}`,
    ),
  );
}

export async function expectContrast(
  foreground: Locator,
  foregroundProperty: ColourSource,
  background: Locator,
  backgroundProperty: ColourSource,
  minimum: number,
): Promise<void> {
  const ink = await renderedColour(foreground, foregroundProperty);
  const surface = await renderedColour(background, backgroundProperty);
  expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(minimum);
}

export async function disabledContrast(
  page: Page,
  target: string | Locator,
  surface: Locator,
): Promise<number> {
  const control =
    typeof target === 'string' ? page.getByTestId(target) : target;
  const opacity = await control.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).opacity),
  );
  const base = await renderedColour(surface, 'backgroundColor');
  const measured =
    typeof target === 'string'
      ? await measureContrast(page, target)
      : await measureLocatorContrast(target);
  return contrastRatio(
    composite(measured.text, base, opacity),
    composite(measured.background, base, opacity),
  );
}

export async function disabledPairContrast(
  foreground: Locator,
  foregroundProperty: ColourSource,
  background: Locator,
  backgroundProperty: ColourSource,
  opacityCarrier: Locator,
  surface: Locator,
): Promise<number> {
  const opacity = await opacityCarrier.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).opacity),
  );
  const base = await renderedColour(surface, 'backgroundColor');
  const ink = await renderedColour(foreground, foregroundProperty);
  const fill = await renderedColour(background, backgroundProperty);
  return contrastRatio(
    composite(ink, base, opacity),
    composite(fill, base, opacity),
  );
}
