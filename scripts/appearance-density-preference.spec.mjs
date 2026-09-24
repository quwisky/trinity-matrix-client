import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  parseNativeAppearanceDensityPreference as parse,
  readNativeAppearanceDensityPreference as readNative,
} from '../e2e/android/appearance-density-preference.mts';

const compact =
  '<string name="trinity.appearance.density">{"version":1,"value":"compact"}</string>';
const absent = { present: false, version: null, value: 'cosy' };

describe('native appearance density XML structure', () => {
  it.each([
    ['commented entry', `<map><!-- ${compact} --></map>`],
    [
      'comments outside the map',
      `<!-- ${compact} --><map/><!-- ${compact} -->`,
    ],
    [
      'CDATA in an unrelated string',
      `<map><string name="unrelated"><![CDATA[${compact}]]></string></map>`,
    ],
    [
      'encoded tag text in an unrelated string',
      '<map><string name="unrelated">&lt;string name=&quot;trinity.appearance.density&quot;&gt;{"version":1,"value":"compact"}&lt;/string&gt;</string></map>',
    ],
    [
      'unrelated value containing the key',
      '<map><string name="unrelated">trinity.appearance.density</string></map>',
    ],
    [
      'unrelated Android preference types',
      '<map><string name="token">a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65; &#x1F600;</string><boolean name="enabled" value="true"/><int name="count" value="2"/><long name="timestamp" value="1750000000000"/><float name="scale" value="1.25"/><set name="tags"><string>one</string><string>two</string></set></map>',
    ],
  ])('keeps density absent for %s', (_name, xml) => {
    expect(parse(xml)).toEqual(absent);
  });

  it.each([
    ['ordinary entry', `<map>${compact}</map>`],
    ['commented duplicate', `<map><!-- ${compact} -->${compact}</map>`],
    [
      'CDATA envelope',
      '<map><string name="trinity.appearance.density"><![CDATA[{"version":1,"value":"compact"}]]></string></map>',
    ],
    [
      'escaped key and envelope',
      '<map><string name="trinity.appearance.densit&#121;">{&quot;version&quot;:1,&quot;value&quot;:&quot;comp&#x61;ct&quot;}</string></map>',
    ],
    [
      'XML declaration and single quoted attribute',
      `<?xml version="1.0" encoding="utf-8" standalone="yes"?><map><string name='trinity.appearance.density'>{"version":1,"value":"compact"}</string></map>`,
    ],
    [
      'unrelated escaped entity text',
      `<map><string name="unrelated">&amp;bogus;</string>${compact}</map>`,
    ],
  ])('reads a saved Compact value with %s', (_name, xml) => {
    expect(parse(xml)).toEqual({ present: true, version: 1, value: 'compact' });
  });

  it.each([
    ['unclosed surrounding tag', `<map><unexpected>${compact}</map>`],
    ['mismatched surrounding tag', `<map><unexpected>${compact}</other></map>`],
    [
      'unclosed unrelated tag',
      `<map><string name="unrelated">${compact}</map>`,
    ],
    [
      'mismatched unrelated tag',
      `<map><string name="unrelated"></boolean>${compact}</map>`,
    ],
    ['unclosed comment', `<map><!-- ${compact}</map>`],
    ['nested map', `<map><map>${compact}</map></map>`],
    [
      'nested density entry',
      `<map><string name="unrelated">${compact}</string></map>`,
    ],
    [
      'element inside density',
      '<map><string name="trinity.appearance.density"><string>{"version":1,"value":"compact"}</string></string></map>',
    ],
    [
      'wrong density element',
      '<map><int name="trinity.appearance.density" value="1"/></map>',
    ],
    [
      'unknown preference element',
      `<map><unexpected name="unrelated"/>${compact}</map>`,
    ],
    [
      'missing preference name',
      `<map><string>unrelated</string>${compact}</map>`,
    ],
    [
      'named string inside set',
      `<map><set name="unrelated">${compact}</set></map>`,
    ],
    [
      'non-string set item',
      `<map><set name="unrelated"><int value="1"/></set>${compact}</map>`,
    ],
    ['map text', `<map>unrelated${compact}</map>`],
    ['map CDATA', `<map><![CDATA[${compact}]]></map>`],
    ['unexpected map attributes', `<map value="unrelated">${compact}</map>`],
    [
      'unexpected string attributes',
      '<map><string name="trinity.appearance.density" value="unrelated">{"version":1,"value":"compact"}</string></map>',
    ],
    ['missing primitive value', `<map><int name="count"/>${compact}</map>`],
    [
      'primitive text',
      `<map><boolean name="enabled" value="true">unrelated</boolean>${compact}</map>`,
    ],
    ['unclosed map', `<map>${compact}`],
    ['multiple roots', `<map>${compact}</map><map/>`],
    [
      'unknown entity in unrelated entry',
      `<map><string name="token">&bogus;</string>${compact}</map>`,
    ],
    [
      'invalid numeric entity',
      `<map><string name="token">&#0;</string>${compact}</map>`,
    ],
    [
      'duplicate attribute',
      `<map><string name="first" name="second"/>${compact}</map>`,
    ],
    ['duplicate density', `<map>${compact}${compact}</map>`],
    [
      'escaped duplicate density key',
      `<map>${compact}<string name="trinity.appearance.densit&#121;">{"version":1,"value":"compact"}</string></map>`,
    ],
    ['doctype', `<!DOCTYPE map><map>${compact}</map>`],
    [
      'declared entity',
      `<!DOCTYPE map [<!ENTITY density 'compact'>]><map><string name="trinity.appearance.density">{"version":1,"value":"&density;"}</string></map>`,
    ],
    [
      'external entity',
      '<!DOCTYPE map [<!ENTITY token SYSTEM "file:///SECRET_DENSITY_XML">]><map/>',
    ],
  ])('rejects %s even if a Compact fragment is present', (_name, xml) => {
    expect(() => parse(xml)).toThrow();
  });

  it.each([
    '<map><SECRET_DENSITY_XML></map>',
    `<map><string name="unrelated">&SECRET_DENSITY_XML;</string>${compact}</map>`,
    '<map><string name="trinity.appearance.density">SECRET_DENSITY_XML</string></map>',
    '<map><string name="trinity.appearance.density">{"version":1,"value":"SECRET_DENSITY_XML"}</string></map>',
  ])('never includes source XML or stored secrets in an error', (xml) => {
    let error;
    try {
      parse(xml);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^Native density Preferences /u);
    expect(inspect(error, { depth: null })).not.toContain('SECRET_DENSITY_XML');
    expect(inspect(error, { depth: null })).not.toContain('<map>');
    expect(error.cause).toBeUndefined();
  });

  it('never satisfies a persisted Compact read from a commented entry', async () => {
    const client = {
      applicationId: 'eu.qwky.trinity',
      signal: new AbortController().signal,
      device: { adb: async () => `<map><!-- ${compact} --></map>` },
    };
    await expect(readNative(client, 'compact', 25)).rejects.toThrow(
      /Timed out waiting for native trinity\.appearance\.density=compact/u,
    );
  });
});
