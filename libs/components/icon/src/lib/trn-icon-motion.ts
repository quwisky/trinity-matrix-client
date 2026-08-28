/**
 * Small, transform-only gestures an icon may perform with its interactive ancestor.
 *
 * This is a closed vocabulary on purpose. A motion is added only when a real control needs
 * it, so Storybook and the browser interaction matrix can keep covering every supported
 * gesture rather than turning this into an open-ended animation utility.
 */
export const TRN_ICON_MOTIONS = [
  'nudge-left',
  'nudge-up',
  'nudge-down',
  'nudge-up-right',
  'pop',
  'rotate',
] as const;

export type TrnIconMotion = (typeof TRN_ICON_MOTIONS)[number];
