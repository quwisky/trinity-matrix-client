import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  AA_NORMAL_TEXT,
  contrastRatio,
  measureLocatorContrast,
  resolveTokenSrgb,
  type Srgb,
} from '../../browser/support/contrast.mts';
import { expectSeparatedFocusRing } from './focus-ring-pixels.mts';
import { boxShadowLayers, computedColour } from './recipe-appearance.mts';
import { openStory, STORYBOOK_THEME_PREVIEWS } from './theme-preview.mts';

const TOOLBAR_STORY = 'components-message-toolbar--all-actions';

/**
 * The focus ring an element actually paints, not a property that happens to hold a colour.
 * Helm controls keep `outline-none`, so the global outline's colour is computed but never
 * drawn; their ring is a box-shadow. An outline counts only when its style is not `none` and
 * it is at least 2px wide. A shadow ring counts only when it is opaque, in the expected
 * colour, and spreads at least 2px. Returns the painted colour.
 */
async function expectPaintedRing(
  element: Locator,
  expected: Srgb,
): Promise<Srgb> {
  const outline = await element.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    };
  });
  if (outline.style !== 'none') {
    expect(outline.width).toBeGreaterThanOrEqual(2);
    const colour = await computedColour(element, 'outline-color');
    expect(colour).toEqual(expected);
    return colour;
  }
  const rings = (await boxShadowLayers(element)).filter(
    (layer) => layer.alpha === 255 && layer.spread >= 2,
  );
  expect(rings.map((layer) => layer.colour)).toContainEqual(expected);
  return expected;
}

/**
 * #1217: a solid action on an attention surface inverts, so its fill stands out from the
 * surface at rest and on hover, its label stays readable on both, and its focus ring stands
 * apart from it across a transparent gap that shows the surface. Returns the resolved
 * attention hover fill.
 */
async function expectAttentionAction(
  page: Page,
  surface: Locator,
  action: Locator,
): Promise<Srgb> {
  await action.evaluate((element) =>
    element.setAttribute('data-testid', 'attention-action'),
  );
  const attentionSurface = await computedColour(surface, 'background-color');
  expect(attentionSurface).toEqual(
    await resolveTokenSrgb(
      page,
      'attention-action',
      '--trinity-state-attention-surface',
    ),
  );
  const restFill = await computedColour(action, 'background-color');
  expect(restFill).toEqual(
    await resolveTokenSrgb(
      page,
      'attention-action',
      '--trinity-state-attention-action-surface',
    ),
  );
  expect(contrastRatio(restFill, attentionSurface)).toBeGreaterThanOrEqual(3);
  expect((await measureLocatorContrast(action)).ratio).toBeGreaterThanOrEqual(
    AA_NORMAL_TEXT,
  );

  await action.hover();
  const hoverSurface = await resolveTokenSrgb(
    page,
    'attention-action',
    '--trinity-state-attention-action-hover-surface',
  );
  await expect
    .poll(() => computedColour(action, 'background-color'))
    .toEqual(hoverSurface);
  expect(hoverSurface).not.toEqual(restFill);
  expect(contrastRatio(hoverSurface, attentionSurface)).toBeGreaterThanOrEqual(
    3,
  );
  expect((await measureLocatorContrast(action)).ratio).toBeGreaterThanOrEqual(
    AA_NORMAL_TEXT,
  );
  await page.mouse.move(0, 0);

  const onAttentionRing = await resolveTokenSrgb(
    page,
    'attention-action',
    '--trinity-focus-ring-on-attention',
  );
  await action.focus();
  await expect(action).toBeFocused();
  const attentionRing = await expectPaintedRing(action, onAttentionRing);
  expect(contrastRatio(attentionRing, attentionSurface)).toBeGreaterThanOrEqual(
    3,
  );
  await action.evaluate((element: HTMLElement) => element.blur());
  // The ring shares the inverted fill's colour, so a transparent gap that shows the surface
  // is what keeps it distinct from the button.
  const ratios = await expectSeparatedFocusRing(page, action, onAttentionRing);
  test.info().annotations.push({
    type: 'contrast',
    description: `attention action ring ${JSON.stringify(ratios)}`,
  });
  return hoverSurface;
}

/**
 * #1224: every focusable on an attention surface sits on the accent, so the surface switches
 * them all to the on-attention ring. A text field (transparent, so its own background is the
 * accent) and a ghost action both use it, at 3:1 or more against the surface.
 */
async function expectAttentionSurfaceRing(
  page: Page,
  surface: Locator,
  focusables: readonly Locator[],
): Promise<void> {
  const attentionSurface = await computedColour(surface, 'background-color');
  for (const [index, focusable] of focusables.entries()) {
    const testId = `attention-focusable-${index}`;
    await focusable.evaluate(
      (element, id) => element.setAttribute('data-testid', id),
      testId,
    );
    await focusable.focus();
    await expect(focusable).toBeFocused();
    const ringColour = await expectPaintedRing(
      focusable,
      await resolveTokenSrgb(page, testId, '--trinity-focus-ring-on-attention'),
    );
    expect(contrastRatio(ringColour, attentionSurface)).toBeGreaterThanOrEqual(
      3,
    );
    await focusable.evaluate((element: HTMLElement) => element.blur());
  }
}

/** Ratios measured by {@link expectAttentionControls}, for the evidence log. */
interface AttentionControlRatios {
  placeholder: number;
  border: number;
  fieldRing: number;
  trackBorder: number;
  selectedFill: number;
  segmentRing: number;
  selectPlaceholder: number;
  selectBorder: number;
  selectRing: number;
}

/**
 * #1241: form controls on an attention surface use the attention control roles. The field's
 * placeholder clears 4.5:1 and its resting border 3:1 against the surface; the segmented
 * track stays the surface colour, so the selected option's inverted fill and the on-attention
 * ring (drawn on a gap in the track colour) clear 3:1 against what is directly behind them;
 * the select trigger's placeholder, border and ring follow the field.
 */
async function expectAttentionControls(
  page: Page,
  surface: Locator,
  controls: { field: Locator; segmented: Locator; select: Locator },
): Promise<AttentionControlRatios> {
  const { field, segmented, select } = controls;
  // The field sits inside the surface, so it resolves the tokens the controls actually see.
  await field.evaluate((element) =>
    element.setAttribute('data-testid', 'attention-controls-field'),
  );
  const token = (name: string) =>
    resolveTokenSrgb(page, 'attention-controls-field', name);
  const attentionSurface = await computedColour(surface, 'background-color');
  expect(attentionSurface).toEqual(
    await token('--trinity-state-attention-surface'),
  );
  const controlBorder = await token('--trinity-state-attention-control-border');
  const placeholderToken = await token(
    '--trinity-state-attention-control-placeholder',
  );
  const onAttentionRing = await token('--trinity-focus-ring-on-attention');

  // Text field: placeholder, resting border and focus ring.
  const placeholder = await field.evaluate((element) => {
    const colour = getComputedStyle(element, '::placeholder').color;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('foundation states: no canvas context');
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  });
  expect(placeholder).toEqual(placeholderToken);
  const fieldBorder = await computedColour(field, 'border-top-color');
  expect(fieldBorder).toEqual(controlBorder);
  await field.focus();
  await expect(field).toBeFocused();
  const fieldRing = await expectPaintedRing(field, onAttentionRing);
  await field.evaluate((element: HTMLElement) => element.blur());

  // Segmented radio group: the track, the selected option and the ring on its gap.
  const track = segmented.getByRole('radiogroup');
  const trackSurface = await computedColour(track, 'background-color');
  expect(trackSurface).toEqual(
    await token('--trinity-state-attention-control-track-surface'),
  );
  const trackBorder = await computedColour(track, 'border-top-color');
  expect(trackBorder).toEqual(controlBorder);
  const selectedRadio = segmented.getByRole('radio', { checked: true });
  const selectedOption = segmented.locator('label[data-state="selected"]');
  const selectedFill = await computedColour(selectedOption, 'background-color');
  expect(selectedFill).toEqual(
    await token('--trinity-state-attention-action-surface'),
  );
  expect(
    (await measureLocatorContrast(selectedOption)).ratio,
  ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  const idleOptions = segmented.locator('label[data-state="idle"]');
  expect(await idleOptions.count()).toBeGreaterThan(0);
  for (const option of await idleOptions.all()) {
    expect((await measureLocatorContrast(option)).ratio).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  }
  // Keyboard modality, so the native radio matches `:focus-visible`.
  await page.keyboard.press('Tab');
  await selectedRadio.focus();
  await expect(selectedRadio).toBeFocused();
  const { offset, width } = await selectedOption.evaluate((element) => {
    const style = getComputedStyle(element);
    const length = (name: string) =>
      Number.parseFloat(style.getPropertyValue(name));
    return {
      offset: length('--trinity-focus-ring-offset'),
      width: length('--trinity-focus-ring-width'),
    };
  });
  expect(offset).toBeGreaterThanOrEqual(2);
  expect(width).toBeGreaterThanOrEqual(2);
  // The gap in the track colour, then the ring beyond it.
  const [gap, ring] = await boxShadowLayers(selectedOption);
  expect(gap).toEqual({ colour: trackSurface, alpha: 255, spread: offset });
  expect(ring).toEqual({
    colour: onAttentionRing,
    alpha: 255,
    spread: offset + width,
  });
  const segmentRing = ring.colour;
  await selectedRadio.evaluate((element: HTMLElement) => element.blur());

  // Select trigger: transparent on the surface, with the attention placeholder and border.
  const trigger = select.getByRole('combobox');
  await trigger.evaluate((element) =>
    element.setAttribute('data-testid', 'attention-select-trigger'),
  );
  expect(await trigger.getAttribute('data-placeholder')).not.toBeNull();
  const selectPlaceholder = await computedColour(trigger, 'color');
  expect(selectPlaceholder).toEqual(placeholderToken);
  const selectContrast = await measureLocatorContrast(trigger);
  expect(selectContrast.background).toEqual(attentionSurface);
  const selectBorder = await computedColour(trigger, 'border-top-color');
  expect(selectBorder).toEqual(controlBorder);
  await trigger.focus();
  await expect(trigger).toBeFocused();
  const selectRing = await expectPaintedRing(trigger, onAttentionRing);
  expect(await computedColour(trigger, 'border-top-color')).toEqual(
    onAttentionRing,
  );
  await trigger.evaluate((element: HTMLElement) => element.blur());

  const ratios = {
    placeholder: contrastRatio(placeholder, attentionSurface),
    border: contrastRatio(fieldBorder, attentionSurface),
    fieldRing: contrastRatio(fieldRing, attentionSurface),
    trackBorder: contrastRatio(trackBorder, attentionSurface),
    selectedFill: contrastRatio(selectedFill, trackSurface),
    segmentRing: contrastRatio(segmentRing, trackSurface),
    selectPlaceholder: contrastRatio(selectPlaceholder, attentionSurface),
    selectBorder: contrastRatio(selectBorder, attentionSurface),
    selectRing: contrastRatio(selectRing, attentionSurface),
  };
  for (const [name, ratio] of Object.entries(ratios)) {
    expect(ratio, name).toBeGreaterThanOrEqual(
      name.toLowerCase().includes('placeholder') ? AA_NORMAL_TEXT : 3,
    );
  }
  return ratios;
}

/** Resolves theme tokens in the cascade of an element inside an attention surface. */
async function attentionTokens(
  page: Page,
  inside: Locator,
  testId: string,
): Promise<(name: string) => Promise<Srgb>> {
  await inside.evaluate(
    (element, id) => element.setAttribute('data-testid', id),
    testId,
  );
  return (name: string) => resolveTokenSrgb(page, testId, name);
}

/** The colour a pseudo-element paints for `property`, flattened to sRGB. */
async function pseudoColour(
  element: Locator,
  pseudo: string,
  property: string,
): Promise<Srgb> {
  return element.evaluate(
    (node, [selector, name]) => {
      const value = getComputedStyle(node, selector).getPropertyValue(name);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('foundation states: no canvas context');
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    },
    [pseudo, property] as const,
  );
}

/** The colours of every opaque box-shadow ring of 2px or more an element paints. */
async function paintedShadowRings(element: Locator): Promise<Srgb[]> {
  return (await boxShadowLayers(element))
    .filter((layer) => layer.alpha === 255 && layer.spread >= 2)
    .map((layer) => layer.colour);
}

/**
 * A focused invalid control must show focus, not only its invalid state: its painted rings
 * switch from the danger ring to the on-attention ring. With `keepsDangerBorder`, the danger
 * border must also stay while focused, so the invalid state is still visible.
 */
async function expectFocusOverInvalid(
  page: Page,
  focusable: Locator,
  painted: Locator,
  danger: Srgb,
  onAttentionRing: Srgb,
  keepsDangerBorder = false,
): Promise<Srgb> {
  await page.keyboard.press('Tab');
  await focusable.focus();
  await expect(focusable).toBeFocused();
  const rings = await paintedShadowRings(painted);
  expect(rings).toContainEqual(onAttentionRing);
  expect(rings).not.toContainEqual(danger);
  if (keepsDangerBorder) {
    expect(await computedColour(painted, 'border-top-color')).toEqual(danger);
  }
  await focusable.evaluate((element: HTMLElement) => element.blur());
  return onAttentionRing;
}

/**
 * A measured control must be painted on the surface, not wrapped or overflowed past its edge
 * onto the canvas: the contrast helpers walk DOM ancestors, which would still report the
 * surface colour for a control drawn outside it.
 */
async function expectInsideSurface(
  surface: Locator,
  controls: readonly Locator[],
): Promise<void> {
  const outer = await surface.boundingBox();
  expect(outer).not.toBeNull();
  for (const control of controls) {
    const inner = await control.boundingBox();
    expect(inner).not.toBeNull();
    expect(inner!.x).toBeGreaterThanOrEqual(outer!.x);
    expect(inner!.y).toBeGreaterThanOrEqual(outer!.y);
    expect(inner!.x + inner!.width).toBeLessThanOrEqual(
      outer!.x + outer!.width,
    );
    expect(inner!.y + inner!.height).toBeLessThanOrEqual(
      outer!.y + outer!.height,
    );
  }
}

/**
 * A choice control on an attention surface draws its focus ring on a gap in the surface
 * colour, because its checked fill shares the ring's colour. Focuses the native input with
 * keyboard modality and checks both box-shadow layers on the painted control. Returns the
 * ring colour.
 */
async function expectRingOnSurfaceGap(
  page: Page,
  native: Locator,
  painted: Locator,
  attentionSurface: Srgb,
  onAttentionRing: Srgb,
): Promise<Srgb> {
  await page.keyboard.press('Tab');
  await native.focus();
  await expect(native).toBeFocused();
  const { offset, width } = await painted.evaluate((element) => {
    const style = getComputedStyle(element);
    const length = (name: string) =>
      Number.parseFloat(style.getPropertyValue(name));
    return {
      offset: length('--trinity-focus-ring-offset'),
      width: length('--trinity-focus-ring-width'),
    };
  });
  expect(offset).toBeGreaterThanOrEqual(2);
  expect(width).toBeGreaterThanOrEqual(2);
  const [gap, ring] = await boxShadowLayers(painted);
  expect(gap).toEqual({ colour: attentionSurface, alpha: 255, spread: offset });
  expect(ring).toEqual({
    colour: onAttentionRing,
    alpha: 255,
    spread: offset + width,
  });
  await native.evaluate((element: HTMLElement) => element.blur());
  return ring.colour;
}

/** Text ratios use the 4.5:1 floor; every other ratio is a graphic, border or ring at 3:1. */
function expectRatioFloors(ratios: Record<string, number>): void {
  for (const [name, ratio] of Object.entries(ratios)) {
    expect(ratio, name).toBeGreaterThanOrEqual(
      /label|description|message|placeholder/iu.test(name) ? AA_NORMAL_TEXT : 3,
    );
  }
}

/**
 * #1244: an outline button, a checkbox, a switch and a file input on an attention surface. The
 * outline button stays transparent with the attention control border and foreground and
 * hovers like a solid action. The unchecked checkbox border and switch track use the
 * attention control border; checked, both invert to the attention action roles like a solid
 * action, so the fill clears 3:1 against the surface and the check mark and thumb clear 3:1
 * against it. Their rings sit on a gap in the surface colour. The file input's button label
 * takes the attention foreground.
 */
async function expectAttentionChoices(
  page: Page,
  surface: Locator,
  controls: {
    outline: Locator;
    expanded: Locator;
    checkbox: Locator;
    switch: Locator;
    file: Locator;
  },
): Promise<Record<string, number>> {
  const { outline, expanded, checkbox, file } = controls;
  await expectInsideSurface(surface, [
    outline,
    expanded,
    checkbox,
    controls.switch,
    file,
  ]);
  const token = await attentionTokens(page, checkbox, 'attention-choice-probe');
  const attentionSurface = await computedColour(surface, 'background-color');
  expect(attentionSurface).toEqual(
    await token('--trinity-state-attention-surface'),
  );
  const controlBorder = await token('--trinity-state-attention-control-border');
  const controlForeground = await token(
    '--trinity-state-attention-control-foreground',
  );
  const actionSurface = await token('--trinity-state-attention-action-surface');
  const actionForeground = await token(
    '--trinity-state-attention-action-foreground',
  );
  const actionHover = await token(
    '--trinity-state-attention-action-hover-surface',
  );
  const onAttentionRing = await token('--trinity-focus-ring-on-attention');

  // Outline button: transparent on the surface, attention border and label, solid-like hover.
  const outlineBorder = await computedColour(outline, 'border-top-color');
  expect(outlineBorder).toEqual(controlBorder);
  expect(await computedColour(outline, 'color')).toEqual(controlForeground);
  const outlineLabel = await measureLocatorContrast(outline);
  expect(outlineLabel.background).toEqual(attentionSurface);
  await outline.hover();
  await expect
    .poll(() => computedColour(outline, 'background-color'))
    .toEqual(actionHover);
  expect(await computedColour(outline, 'color')).toEqual(actionForeground);
  const outlineHoverLabel = await measureLocatorContrast(outline);
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await outline.focus();
  await expect(outline).toBeFocused();
  const outlineRing = await expectPaintedRing(outline, onAttentionRing);
  expect(await computedColour(outline, 'border-top-color')).toEqual(
    onAttentionRing,
  );
  await outline.evaluate((element: HTMLElement) => element.blur());

  // Checkbox: unchecked border, then the inverted fill and check mark once checked.
  const checkboxNative = checkbox.getByRole('checkbox');
  const box = checkbox.locator('span[aria-hidden="true"]');
  await expect(checkboxNative).not.toBeChecked();
  const checkboxBorder = await computedColour(box, 'border-top-color');
  expect(checkboxBorder).toEqual(controlBorder);
  await checkboxNative.check();
  await expect(box).toHaveAttribute('data-checked', '');
  const checkboxFill = await computedColour(box, 'background-color');
  expect(checkboxFill).toEqual(actionSurface);
  expect(await computedColour(box, 'border-top-color')).toEqual(actionSurface);
  const checkMark = await computedColour(box, 'color');
  expect(checkMark).toEqual(actionForeground);
  const checkboxRing = await expectRingOnSurfaceGap(
    page,
    checkboxNative,
    box,
    attentionSurface,
    onAttentionRing,
  );

  // Switch: the unchecked track and thumb, then the inverted track once checked.
  const switchNative = controls.switch.getByRole('switch');
  const track = controls.switch.locator('span[aria-hidden="true"]');
  const thumb = track.locator('span');
  await expect(switchNative).not.toBeChecked();
  const switchTrack = await computedColour(track, 'background-color');
  expect(switchTrack).toEqual(controlBorder);
  const switchThumb = await computedColour(thumb, 'background-color');
  expect(switchThumb).toEqual(actionForeground);
  await switchNative.check();
  await expect(track).toHaveAttribute('data-checked', 'true');
  const switchCheckedTrack = await computedColour(track, 'background-color');
  expect(switchCheckedTrack).toEqual(actionSurface);
  const switchCheckedThumb = await computedColour(thumb, 'background-color');
  expect(switchCheckedThumb).toEqual(actionForeground);
  const switchRing = await expectRingOnSurfaceGap(
    page,
    switchNative,
    track,
    attentionSurface,
    onAttentionRing,
  );

  const fileLabel = await pseudoColour(file, '::file-selector-button', 'color');
  expect(fileLabel).toEqual(controlForeground);

  // An outline trigger holding an open menu stays transparent, not Helm's grey chip.
  await expect(expanded).toHaveAttribute('aria-expanded', 'true');
  const expandedLabel = await measureLocatorContrast(expanded);
  expect(expandedLabel.background).toEqual(attentionSurface);
  expect(await computedColour(expanded, 'color')).toEqual(controlForeground);
  expect(await computedColour(expanded, 'border-top-color')).toEqual(
    controlBorder,
  );

  const ratios = {
    fileButtonLabel: contrastRatio(fileLabel, attentionSurface),
    expandedLabel: expandedLabel.ratio,
    outlineBorder: contrastRatio(outlineBorder, attentionSurface),
    outlineLabel: outlineLabel.ratio,
    outlineHoverFill: contrastRatio(actionHover, attentionSurface),
    outlineHoverLabel: outlineHoverLabel.ratio,
    outlineRing: contrastRatio(outlineRing, attentionSurface),
    checkboxBorder: contrastRatio(checkboxBorder, attentionSurface),
    checkboxFill: contrastRatio(checkboxFill, attentionSurface),
    checkMark: contrastRatio(checkMark, checkboxFill),
    checkboxRing: contrastRatio(checkboxRing, attentionSurface),
    switchTrack: contrastRatio(switchTrack, attentionSurface),
    switchThumb: contrastRatio(switchThumb, switchTrack),
    switchCheckedTrack: contrastRatio(switchCheckedTrack, attentionSurface),
    switchCheckedThumb: contrastRatio(switchCheckedThumb, switchCheckedTrack),
    switchRing: contrastRatio(switchRing, attentionSurface),
  };
  expectRatioFloors(ratios);
  return ratios;
}

/**
 * #1244: invalid fields, an invalid select and an invalid checkbox on an attention surface
 * take the attention danger role, which clears 3:1 against the accent. Each also paints an
 * opaque danger ring of 2px or more, so the state does not rely on hue alone, and the error
 * messages stay readable. Focus replaces the danger ring with the on-attention ring, and a
 * checked invalid checkbox keeps its danger border and ring.
 */
async function expectAttentionFieldStates(
  page: Page,
  surface: Locator,
  controls: {
    fields: readonly [Locator, ...Locator[]];
    select?: Locator;
    checkbox?: Locator;
  },
): Promise<Record<string, number>> {
  const { fields, select, checkbox } = controls;
  await expectInsideSurface(surface, [
    ...fields,
    ...(select ? [select] : []),
    ...(checkbox ? [checkbox] : []),
  ]);
  for (const field of fields) {
    const messageId = await field.getAttribute('aria-describedby');
    expect(messageId).not.toBeNull();
    await expectInsideSurface(surface, [page.locator(`[id="${messageId}"]`)]);
  }
  const token = await attentionTokens(page, fields[0], 'attention-state-probe');
  const attentionSurface = await computedColour(surface, 'background-color');
  expect(attentionSurface).toEqual(
    await token('--trinity-state-attention-surface'),
  );
  const danger = await token('--trinity-state-attention-control-danger');
  const onAttentionRing = await token('--trinity-focus-ring-on-attention');
  const ratios: Record<string, number> = {};

  for (const [index, field] of fields.entries()) {
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    const border = await computedColour(field, 'border-top-color');
    expect(border).toEqual(danger);
    const ring = await expectPaintedRing(field, danger);
    const messageId = await field.getAttribute('aria-describedby');
    expect(messageId).not.toBeNull();
    const message = page.locator(`[id="${messageId}"]`);
    await expect(message).toBeVisible();
    ratios[`field${index}Border`] = contrastRatio(border, attentionSurface);
    ratios[`field${index}Ring`] = contrastRatio(ring, attentionSurface);
    ratios[`field${index}Message`] = (
      await measureLocatorContrast(message)
    ).ratio;
    ratios[`field${index}FocusRing`] = contrastRatio(
      await expectFocusOverInvalid(
        page,
        field,
        field,
        danger,
        onAttentionRing,
        true,
      ),
      attentionSurface,
    );
  }

  if (select) {
    const trigger = select.getByRole('combobox');
    await expect(trigger).toHaveAttribute('aria-invalid', 'true');
    const selectBorder = await computedColour(trigger, 'border-top-color');
    expect(selectBorder).toEqual(danger);
    const selectRing = await expectPaintedRing(trigger, danger);
    ratios['selectBorder'] = contrastRatio(selectBorder, attentionSurface);
    ratios['selectRing'] = contrastRatio(selectRing, attentionSurface);
    ratios['selectFocusRing'] = contrastRatio(
      await expectFocusOverInvalid(
        page,
        trigger,
        trigger,
        danger,
        onAttentionRing,
        true,
      ),
      attentionSurface,
    );
  }

  if (checkbox) {
    const box = checkbox.locator('span[aria-hidden="true"]');
    const native = checkbox.getByRole('checkbox');
    await expect(native).toHaveAttribute('aria-invalid', 'true');
    const checkboxBorder = await computedColour(box, 'border-top-color');
    expect(checkboxBorder).toEqual(danger);
    ratios['checkboxBorder'] = contrastRatio(checkboxBorder, attentionSurface);
    ratios['checkboxRing'] = contrastRatio(
      await expectPaintedRing(box, danger),
      attentionSurface,
    );
    // Checked, the danger border and ring survive the inverted fill.
    await native.check();
    await expect(box).toHaveAttribute('data-checked', '');
    expect(await computedColour(box, 'border-top-color')).toEqual(danger);
    await expectPaintedRing(box, danger);
    ratios['checkedCheckboxBorder'] = contrastRatio(danger, attentionSurface);
    ratios['checkboxFocusRing'] = contrastRatio(
      await expectRingOnSurfaceGap(
        page,
        native,
        box,
        attentionSurface,
        onAttentionRing,
      ),
      attentionSurface,
    );
  }

  expectRatioFloors(ratios);
  return ratios;
}

/**
 * #1244: a list radio group and segmented option descriptions on an attention surface. The
 * idle ring uses the attention control border, the checked dot and the labels the attention
 * foreground, and the focused ring the on-attention ring. A segmented description follows its
 * option's foreground, so it stays readable on the track and on the inverted selected fill.
 * When given, an invalid list group's rings take the attention danger border and an opaque
 * danger ring, and focus replaces that ring with the on-attention ring.
 */
async function expectAttentionStackedChoices(
  page: Page,
  surface: Locator,
  controls: { list: Locator; segmented: Locator; invalidList?: Locator },
): Promise<Record<string, number>> {
  const { list, segmented, invalidList } = controls;
  await expectInsideSurface(surface, [
    list,
    segmented,
    ...(invalidList ? [invalidList] : []),
  ]);
  const token = await attentionTokens(page, list, 'attention-stacked-probe');
  const attentionSurface = await computedColour(surface, 'background-color');
  expect(attentionSurface).toEqual(
    await token('--trinity-state-attention-surface'),
  );
  const controlBorder = await token('--trinity-state-attention-control-border');
  const controlForeground = await token(
    '--trinity-state-attention-control-foreground',
  );
  const onAttentionRing = await token('--trinity-focus-ring-on-attention');
  const ratios: Record<string, number> = {};

  const idle = list.locator('label[data-state="idle"]').first();
  const selected = list.locator('label[data-state="selected"]');
  const idleRing = idle.locator('span[aria-hidden="true"]');
  const radioBorder = await computedColour(idleRing, 'border-top-color');
  expect(radioBorder).toEqual(controlBorder);
  ratios['radioBorder'] = contrastRatio(radioBorder, attentionSurface);
  const dot = selected.locator('span[aria-hidden="true"] > span');
  const radioDot = await computedColour(dot, 'background-color');
  expect(radioDot).toEqual(controlForeground);
  ratios['radioDot'] = contrastRatio(radioDot, attentionSurface);
  for (const [index, option] of (await list.locator('label').all()).entries()) {
    ratios[`radio${index}Label`] = (await measureLocatorContrast(option)).ratio;
    ratios[`radio${index}Description`] = (
      await measureLocatorContrast(option.locator('small'))
    ).ratio;
  }
  await page.keyboard.press('Tab');
  const selectedRadio = selected.getByRole('radio');
  await selectedRadio.focus();
  await expect(selectedRadio).toBeFocused();
  const selectedRing = selected.locator('span[aria-hidden="true"]');
  const radioRing = await expectPaintedRing(selectedRing, onAttentionRing);
  expect(await computedColour(selectedRing, 'border-top-color')).toEqual(
    onAttentionRing,
  );
  ratios['radioRing'] = contrastRatio(radioRing, attentionSurface);
  await selectedRadio.evaluate((element: HTMLElement) => element.blur());

  if (invalidList) {
    const danger = await token('--trinity-state-attention-control-danger');
    const radios = invalidList.getByRole('radio');
    expect(await radios.count()).toBeGreaterThan(0);
    for (const radio of await radios.all()) {
      await expect(radio).toHaveAttribute('aria-invalid', 'true');
    }
    const firstOption = invalidList.locator('label').first();
    const invalidRing = firstOption.locator('span[aria-hidden="true"]');
    const invalidBorder = await computedColour(invalidRing, 'border-top-color');
    expect(invalidBorder).toEqual(danger);
    ratios['invalidRadioBorder'] = contrastRatio(
      invalidBorder,
      attentionSurface,
    );
    ratios['invalidRadioRing'] = contrastRatio(
      await expectPaintedRing(invalidRing, danger),
      attentionSurface,
    );
    ratios['invalidRadioFocusRing'] = contrastRatio(
      await expectFocusOverInvalid(
        page,
        firstOption.getByRole('radio'),
        invalidRing,
        danger,
        onAttentionRing,
      ),
      attentionSurface,
    );
  }

  const descriptions = segmented.locator('small');
  expect(await descriptions.count()).toBeGreaterThan(1);
  for (const [index, description] of (await descriptions.all()).entries()) {
    ratios[`segment${index}Description`] = (
      await measureLocatorContrast(description)
    ).ratio;
  }

  expectRatioFloors(ratios);
  return ratios;
}

test.describe('semantic design foundations', () => {
  for (const { theme, mode } of STORYBOOK_THEME_PREVIEWS) {
    test(`${theme.id} ${mode.id} toolbar states use accessible semantic recipes`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openStory(page, TOOLBAR_STORY, theme.id, mode.id);
      const toolbar = page.getByRole('toolbar', { name: 'Message actions' });
      const action = page.getByRole('button', { name: 'Add reaction' });
      await expect(toolbar).toBeVisible();
      await action.evaluate((element) =>
        element.setAttribute('data-testid', 'foundation-action'),
      );

      const floating = await resolveTokenSrgb(
        page,
        'foundation-action',
        '--trinity-surface-floating',
      );
      expect(await computedColour(toolbar, 'background-color')).toEqual(
        floating,
      );

      await action.hover();
      await expect
        .poll(() => computedColour(action, 'background-color'))
        .toEqual(
          await resolveTokenSrgb(
            page,
            'foundation-action',
            '--trinity-state-hover-surface',
          ),
        );

      await page.mouse.down();
      await expect
        .poll(() => computedColour(action, 'background-color'))
        .toEqual(
          await resolveTokenSrgb(
            page,
            'foundation-action',
            '--trinity-state-pressed-surface',
          ),
        );
      await page.mouse.up();

      // Pressing the reaction action activates it, so close that picker and restart the
      // tab sequence from the document. This verifies keyboard focus, not mouse focus.
      await page.keyboard.press('Escape');
      await action.evaluate((element: HTMLElement) => element.blur());
      await page.mouse.move(0, 0);
      // Establish keyboard modality, then target the representative control. Storybook's
      // preview inserts its own first tabbable before the story canvas.
      await page.keyboard.press('Tab');
      await action.focus();
      await expect(action).toBeFocused();
      expect(
        await action.evaluate((element) => element.matches(':focus-visible')),
      ).toBe(true);
      const focus = await expectPaintedRing(
        action,
        await resolveTokenSrgb(
          page,
          'foundation-action',
          '--trinity-focus-ring',
        ),
      );
      expect(contrastRatio(focus, floating)).toBeGreaterThanOrEqual(3);

      await openStory(page, 'components-banner--accent', theme.id, mode.id);
      const hoverSurface = await expectAttentionAction(
        page,
        page.locator('[data-variant="accent"]'),
        page.getByRole('button', { name: 'Set up' }),
      );

      // An anchor action needs its own hover rule: Helm's `[a]:hover` outranks the plain one.
      await openStory(
        page,
        'components-banner--accent-actions',
        theme.id,
        mode.id,
      );
      const linkAction = page.getByRole('link', { name: 'Learn more' });
      await linkAction.hover();
      await expect
        .poll(() => computedColour(linkAction, 'background-color'))
        .toEqual(hoverSurface);

      // #1224: the accent page header and accent overlay surface paint the same attention
      // surface, so a solid action in either inverts the same way. The toolbar layout's
      // own background loses to the accent, so it is checked as well.
      for (const layout of ['page', 'toolbar'] as const) {
        await openStory(
          page,
          'components-page-header--accent-action',
          theme.id,
          mode.id,
          'cosy',
          `layout:${layout}`,
        );
        const header = page.locator('header[data-trn-variant="accent"]');
        await expect(header).toHaveAttribute('data-trn-layout', layout);
        await expectAttentionAction(
          page,
          header,
          page.getByRole('button', { name: 'Verify' }),
        );
      }

      // #1241: form controls on the accent header, in both layouts, and the accent overlay.
      for (const layout of ['page', 'toolbar'] as const) {
        await openStory(
          page,
          'components-page-header--accent-controls',
          theme.id,
          mode.id,
          'cosy',
          `layout:${layout}`,
        );
        const header = page.locator('header[data-trn-variant="accent"]');
        await expect(header).toHaveAttribute('data-trn-layout', layout);
        const ratios = await expectAttentionControls(page, header, {
          field: page.getByRole('textbox', { name: 'Filter members' }),
          segmented: page.locator('trn-radio-group'),
          select: page.locator('trn-select'),
        });
        test.info().annotations.push({
          type: 'contrast',
          description: `${theme.id} ${mode.id} header ${layout} ${JSON.stringify(ratios)}`,
        });
      }

      await openStory(
        page,
        'components-overlay-recipes--accent-surface',
        theme.id,
        mode.id,
      );
      const overlayRatios = await expectAttentionControls(
        page,
        page.getByTestId('accent-overlay-surface'),
        {
          field: page.getByRole('textbox', { name: 'Recovery key' }),
          segmented: page.locator('trn-radio-group'),
          select: page.locator('trn-select'),
        },
      );
      test.info().annotations.push({
        type: 'contrast',
        description: `${theme.id} ${mode.id} overlay ${JSON.stringify(overlayRatios)}`,
      });
      await expectAttentionSurfaceRing(
        page,
        page.getByTestId('accent-overlay-surface'),
        [
          page.getByRole('textbox', { name: 'Recovery key' }),
          page.getByRole('button', { name: 'Not now' }),
        ],
      );
      await expectAttentionAction(
        page,
        page.getByTestId('accent-overlay-surface'),
        page.getByRole('button', { name: 'Verify now' }),
      );
      // The attention hover token is shared, so the banner step's `hoverSurface` applies here.
      const overlayLink = page.getByRole('link', { name: 'Learn more' });
      await overlayLink.hover();
      await expect
        .poll(() => computedColour(overlayLink, 'background-color'))
        .toEqual(hoverSurface);
      await page.mouse.move(0, 0);

      await openStory(page, 'components-input--default', theme.id, mode.id);
      const field = page.getByRole('textbox', { name: 'Room name' });
      await field.evaluate((element) => {
        element.setAttribute('data-testid', 'focus-field');
        const probe = document.createElement('span');
        probe.setAttribute('data-testid', 'focus-halo-probe');
        // Match Helm's `ring-ring/50` in the browser's own colour space, composited over
        // the Storybook canvas instead of comparing the opaque source token.
        probe.style.background =
          'color-mix(in oklab, var(--ring) 50%, var(--background))';
        document.body.append(probe);
      });
      await field.focus();
      await expect(field).toBeFocused();
      expect(
        await field.evaluate(
          (element) => getComputedStyle(element).outlineStyle,
        ),
      ).toBe('none');
      expect(
        await field.evaluate((element) => getComputedStyle(element).boxShadow),
      ).not.toBe('none');
      const halo = await computedColour(
        page.getByTestId('focus-halo-probe'),
        'background-color',
      );
      const fieldSurface = await resolveTokenSrgb(
        page,
        'focus-field',
        '--background',
      );
      expect(contrastRatio(halo, fieldSurface)).toBeGreaterThanOrEqual(3);
    });
  }

  for (const { theme, mode } of STORYBOOK_THEME_PREVIEWS) {
    test(`${theme.id} ${mode.id} remaining controls use attention roles on accent surfaces`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const header = page.locator('header[data-trn-variant="accent"]');
      const evidence: Record<string, Record<string, number>> = {};

      // #1244: inline controls on the accent header, in both layouts.
      for (const layout of ['page', 'toolbar'] as const) {
        await openStory(
          page,
          'components-page-header--accent-choice-controls',
          theme.id,
          mode.id,
          'cosy',
          `layout:${layout}`,
        );
        await expect(header).toHaveAttribute('data-trn-layout', layout);
        evidence[`header ${layout} choices`] = await expectAttentionChoices(
          page,
          header,
          {
            outline: page.getByRole('button', { name: 'Export' }),
            checkbox: page.locator('trn-checkbox'),
            switch: page.locator('trn-switch'),
            file: page.getByLabel('Import members'),
            expanded: page.getByRole('button', { name: 'Filters' }),
          },
        );

        await openStory(
          page,
          'components-page-header--accent-field-states',
          theme.id,
          mode.id,
          'cosy',
          `layout:${layout}`,
        );
        await expect(header).toHaveAttribute('data-trn-layout', layout);
        evidence[`header ${layout} states`] = await expectAttentionFieldStates(
          page,
          header,
          {
            fields: [page.getByRole('textbox', { name: 'Invitee' })],
            select: page.locator('trn-select'),
            checkbox: page.locator('trn-checkbox'),
          },
        );
      }

      // Stacked controls only fit the page layout; the toolbar is a fixed 48px bar.
      await openStory(
        page,
        'components-page-header--accent-stacked-controls',
        theme.id,
        mode.id,
      );
      await expect(header).toHaveAttribute('data-trn-layout', 'page');
      evidence['header page stacked'] = await expectAttentionStackedChoices(
        page,
        header,
        {
          list: page.locator(
            'trn-radio-group[data-layout="list"]:not([data-invalid])',
          ),
          segmented: page.locator('trn-radio-group[data-layout="segmented"]'),
          invalidList: page.locator(
            'trn-radio-group[data-layout="list"][data-invalid="true"]',
          ),
        },
      );
      evidence['header page textarea'] = await expectAttentionFieldStates(
        page,
        header,
        { fields: [page.getByRole('textbox', { name: 'Room topic' })] },
      );

      // Every remaining control in the accent overlay.
      await openStory(
        page,
        'components-overlay-recipes--accent-surface-controls',
        theme.id,
        mode.id,
      );
      const overlay = page.getByTestId('accent-overlay-controls');
      evidence['overlay choices'] = await expectAttentionChoices(
        page,
        overlay,
        {
          outline: page.getByRole('button', { name: 'Export key' }),
          checkbox: page
            .locator('label', { hasText: 'Remember this device' })
            .locator('trn-checkbox'),
          switch: page.locator('trn-switch'),
          file: page.getByLabel('Key file'),
          expanded: page.getByRole('button', { name: 'More options' }),
        },
      );
      evidence['overlay states'] = await expectAttentionFieldStates(
        page,
        overlay,
        {
          fields: [
            page.getByRole('textbox', { name: 'Passphrase' }),
            page.getByRole('textbox', { name: 'Backup note' }),
          ],
          select: page.locator('trn-select'),
          checkbox: page
            .locator('label', { hasText: 'I saved my key' })
            .locator('trn-checkbox'),
        },
      );
      evidence['overlay stacked'] = await expectAttentionStackedChoices(
        page,
        overlay,
        {
          list: page.locator('trn-radio-group[data-layout="list"]'),
          segmented: page.locator('trn-radio-group[data-layout="segmented"]'),
        },
      );

      for (const [where, ratios] of Object.entries(evidence)) {
        test.info().annotations.push({
          type: 'contrast',
          description: `${theme.id} ${mode.id} ${where} ${JSON.stringify(ratios)}`,
        });
      }
    });
  }
});
