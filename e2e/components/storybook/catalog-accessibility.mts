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

interface AxeBrowserApi {
  configure(config: {
    readonly rules: readonly {
      readonly enabled: boolean;
      readonly id: string;
    }[];
  }): void;
  run(context: Element | AxeContext): Promise<AxeScan>;
}

interface AxeContext {
  readonly exclude: readonly (readonly string[])[];
  readonly include: readonly (readonly string[])[];
}

export async function runAxe(
  page: Page,
  excludedSelectors: readonly string[] = [],
): Promise<AxeScan> {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async (selectors) => {
    const browserAxe = (
      window as typeof window & { readonly axe: AxeBrowserApi }
    ).axe;
    // Story canvases are fragments, so an application-level landmark is not required.
    browserAxe.configure({ rules: [{ id: 'region', enabled: false }] });
    return selectors.length === 0
      ? browserAxe.run(document.body)
      : browserAxe.run({
          include: [['body']],
          exclude: selectors.map((selector) => [selector]),
        });
  }, excludedSelectors);
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
