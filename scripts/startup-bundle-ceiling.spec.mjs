import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CEILING_BYTES,
  checkStartupBundle,
  startupClosure,
} from './startup-bundle-ceiling.mjs';

const temporary = [];

function bundle(
  files,
  html = '<script src="main-A.js" type="module"></script>',
) {
  const root = mkdtempSync(join(tmpdir(), 'trinity-startup-'));
  temporary.push(root);
  if (html !== null) writeFileSync(join(root, 'index.html'), html);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, name), body);
  }
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('startup bundle ceiling', () => {
  it('passes a closure within the ceiling', () => {
    const root = bundle({
      'main-A.js': 'import{a}from"./chunk-B.js";a();',
      'chunk-B.js': 'export const a=1;',
    });
    expect(checkStartupBundle(root, 1000)).toContain('2 files');
  });

  it('fails an oversized closure with sizes and the remedy', () => {
    const root = bundle({ 'main-A.js': 'x'.repeat(150) });
    expect(() => checkStartupBundle(root, 100)).toThrow(
      /150 bytes.*ceiling 100.*50 bytes over.*dynamic import.*raise CEILING_BYTES/s,
    );
  });

  it('does not count files reached only by dynamic import', () => {
    const root = bundle({
      'main-A.js': 'const l=()=>import("./lazy-C.js");',
      'lazy-C.js': 'x'.repeat(500),
    });
    expect(startupClosure(root).files).toEqual(['main-A.js']);
  });

  it('counts a file reached through two paths once', () => {
    const shared = 'export const s=1;';
    const root = bundle({
      'main-A.js': 'import"./chunk-B.js";export*from"./chunk-D.js";',
      'chunk-B.js': 'import{s}from"./chunk-D.js";',
      'chunk-D.js': shared,
    });
    const { files, totalBytes } = startupClosure(root);
    expect(files).toEqual(['chunk-B.js', 'chunk-D.js', 'main-A.js']);
    expect(totalBytes).toBe(
      Buffer.byteLength('import"./chunk-B.js";export*from"./chunk-D.js";') +
        Buffer.byteLength('import{s}from"./chunk-D.js";') +
        shared.length,
    );
  });

  it('fails clearly without index.html or without the main script', () => {
    expect(() => startupClosure(bundle({}, null))).toThrow(
      /index\.html is missing/,
    );
    expect(() => startupClosure(bundle({}))).toThrow(/main-A\.js is missing/);
    expect(() => startupClosure(bundle({}, '<main></main>'))).toThrow(
      /names no script/,
    );
  });

  it('records a positive ceiling', () => {
    expect(CEILING_BYTES).toBeGreaterThan(0);
  });
});
