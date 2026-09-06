import type { Page } from '@playwright/test';

export interface SettingsLayoutMetrics {
  readonly headerHeight: number;
  readonly directoryWidth: number;
  readonly directoryIconWidth: number;
  readonly directoryLabelFontSize: number;
  readonly detailStartsAfterDirectory: boolean;
  readonly detailOverflowY: string;
  readonly directoryOverflowY: string;
  readonly horizontalOverflow: number;
  readonly titleFontSize: number;
  readonly titleLineHeight: number;
}

/** Read geometry that belongs to the public settings frame rather than a domain panel. */
export async function settingsLayoutMetrics(
  page: Page,
  {
    rootTestId,
    directoryTestId,
    detailTestId,
  }: {
    readonly rootTestId: string;
    readonly directoryTestId: string;
    readonly detailTestId: string;
  },
): Promise<SettingsLayoutMetrics> {
  return page.getByTestId(rootTestId).evaluate(
    (root, { directoryTestId, detailTestId }) => {
      const header = root.querySelector<HTMLElement>(
        '.settings-layout__header',
      );
      const title = header?.querySelector<HTMLElement>('h1');
      const directory = root.querySelector<HTMLElement>(
        `[data-testid="${directoryTestId}"]`,
      );
      const detail = root.querySelector<HTMLElement>(
        `[data-testid="${detailTestId}"]`,
      );
      const icon = directory?.querySelector<HTMLElement>('trn-icon');
      const label = directory?.querySelector<HTMLElement>(
        '.settings-layout__directory-label',
      );
      if (!header || !title || !directory || !detail || !icon || !label) {
        throw new Error('shared settings frame geometry is incomplete');
      }

      const headerBox = header.getBoundingClientRect();
      const directoryBox = directory.getBoundingClientRect();
      const detailBox = detail.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      const titleStyle = getComputedStyle(title);
      const labelStyle = getComputedStyle(label);
      const directoryStyle = getComputedStyle(directory);
      const detailStyle = getComputedStyle(detail);
      return {
        headerHeight: headerBox.height,
        directoryWidth: directoryBox.width,
        directoryIconWidth: iconBox.width,
        directoryLabelFontSize: Number.parseFloat(labelStyle.fontSize),
        detailStartsAfterDirectory: detailBox.left >= directoryBox.right - 1,
        detailOverflowY: detailStyle.overflowY,
        directoryOverflowY: directoryStyle.overflowY,
        horizontalOverflow: root.scrollWidth - root.clientWidth,
        titleFontSize: Number.parseFloat(titleStyle.fontSize),
        titleLineHeight: Number.parseFloat(titleStyle.lineHeight),
      };
    },
    { directoryTestId, detailTestId },
  );
}
