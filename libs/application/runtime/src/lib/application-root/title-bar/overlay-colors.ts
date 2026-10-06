/**
 * Normalise any CSS colour to `#rrggbb`; `null` when the browser cannot parse it.
 * Opaque colours only: alpha is ignored (the theme surface and text tokens are opaque).
 */
export function cssColorToHex(css: string): string | null {
  const value = css.trim();
  if (!value) return null;
  // Percentages and fractions are not plain 0-255 channels; the canvas resolves those.
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?![\d%.])/.exec(value);
  const channels = rgb
    ? [rgb[1], rgb[2], rgb[3]].map(Number)
    : canvasChannels(value);
  return channels
    ? `#${channels.map((c) => Math.min(255, c).toString(16).padStart(2, '0')).join('')}`
    : null;
}

// oklch() and friends are not legacy-serialised by the engine; a 1px canvas read-back is the
// one portable way to get sRGB channels for them.
function canvasChannels(css: string): number[] | null {
  try {
    const context = document
      .createElement('canvas')
      .getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    // An unparseable value leaves fillStyle untouched. Two different sentinels tell that
    // apart from a genuine black or white input, which lands on both runs alike.
    context.fillStyle = '#000000';
    context.fillStyle = css;
    const first = context.fillStyle;
    context.fillStyle = '#ffffff';
    context.fillStyle = css;
    if (first !== context.fillStyle) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  } catch {
    return null;
  }
}
