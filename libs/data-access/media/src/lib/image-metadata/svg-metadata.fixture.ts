/**
 * SVG documents for the metadata-stripping specs, written the way Inkscape and Adobe
 * Illustrator save them. Identifying text ("Alice Example", "Berlin", a home directory)
 * sits in the metadata, comments and editor attributes that a strip must remove.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

export const INKSCAPE_SVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) by Alice Example -->

<svg
   width="10"
   height="10"
   viewBox="0 0 10 10"
   version="1.1"
   id="svg1"
   inkscape:version="1.3 (0e150ed6c4, 2023-07-21)"
   sodipodi:docname="home-Berlin.svg"
   inkscape:export-filename="/home/alice/Pictures/Berlin.png"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <title>Logo</title>
  <desc>A red square</desc>
  <sodipodi:namedview id="namedview1" pagecolor="#ffffff" inkscape:window-width="1920"/>
  <metadata id="metadata1"><rdf:RDF><cc:Work rdf:about=""><dc:creator><cc:Agent><dc:title>Alice Example</dc:title></cc:Agent></dc:creator></cc:Work></rdf:RDF></metadata>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <!-- drawn at home in Berlin -->
    <rect x="0" y="0" width="10" height="10" fill="red"/>
  </g>
</svg>
`;

/**
 * {@link INKSCAPE_SVG} after a strip, as the platform serializer writes it. The whitespace
 * around removed nodes stays (it can matter inside `<text>`), hence the indented blank lines.
 */
export const INKSCAPE_SVG_STRIPPED = [
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
  '<svg width="10" height="10" viewBox="0 0 10 10" version="1.1" id="svg1" xmlns="http://www.w3.org/2000/svg">',
  '  <title>Logo</title>',
  '  <desc>A red square</desc>',
  '  ',
  '  ',
  '  <g id="layer1">',
  '    ',
  '    <rect x="0" y="0" width="10" height="10" fill="red"/>',
  '  </g>',
  '</svg>',
  '',
].join('\n');

export const ILLUSTRATOR_SVG = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:x="http://ns.adobe.com/Extensibility/1.0/" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" xmlns:graph="http://ns.adobe.com/Graphs/1.0/" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 10 10" xml:space="preserve" i:viewOrigin="0 10">
<switch>
<foreignObject requiredExtensions="http://ns.adobe.com/AdobeIllustrator/10.0/" x="0" y="0" width="1" height="1"><i:pgfRef xlink:href="#adobe_illustrator_pgf"/></foreignObject>
<g i:extraneous="self"><use xlink:href="#square"/><rect id="square" width="10" height="10" fill="red"/></g>
</switch>
<i:pgf id="adobe_illustrator_pgf"><![CDATA[eJzLSM3JyVcozy/KSQEAGgsEXQ== Alice Example]]></i:pgf>
</svg>
`;

/** A plain SVG with a doctype, a stylesheet instruction and a CDATA style, nothing to strip. */
export const CLEAN_SVG = `<?xml version="1.0"?>
<?xml-stylesheet href="style.css" type="text/css"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <style><![CDATA[rect { fill: red; }]]></style>
  <title>Square</title>
  <rect width="10" height="10"/>
</svg>
`;

/**
 * An SVG of `elements` groups with `attributes` attributes each, plus a comment to remove.
 * `editor` puts them in Illustrator's namespace, so a strip removes every one of them.
 */
export function manyAttributesSvg(
  elements: number,
  attributes: number,
  { editor = true }: { readonly editor?: boolean } = {},
): Uint8Array<ArrayBuffer> {
  const prefix = editor ? 'i:' : '';
  const names = Array.from(
    { length: attributes },
    (_, i) => `${prefix}a${i}=""`,
  ).join(' ');
  return utf8(
    `<svg xmlns="${SVG_NS}" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/">` +
      `<!-- Alice Example -->${`<g ${names}/>`.repeat(elements)}</svg>`,
  );
}

/** An Inkscape drawing of `paths` paths with 6 attributes each, 2 of them Inkscape's. */
export function inkscapePathsSvg(paths: number): Uint8Array<ArrayBuffer> {
  const path = (i: number) =>
    `<path id="p${i}" d="M0 0L10 10" style="fill:#f00" class="c" ` +
    `sodipodi:nodetypes="cc" inkscape:connector-curvature="0"/>`;
  return utf8(
    `<svg xmlns="${SVG_NS}" ` +
      'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" ' +
      'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">' +
      `<!-- Alice Example -->${Array.from({ length: paths }, (_, i) => path(i)).join('')}</svg>`,
  );
}

/** An SVG of `elements` empty groups. */
export function manyElementsSvg(elements: number): Uint8Array<ArrayBuffer> {
  return utf8(
    `<svg xmlns="${SVG_NS}"><!-- Alice Example -->${'<g/>'.repeat(elements)}</svg>`,
  );
}
