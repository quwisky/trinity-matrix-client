// @vitest-environment jsdom
import { Blob as NodeBlob, resolveObjectURL } from 'node:buffer';
import { describe, expect, it } from 'vitest';

// Our media tests require real binary previews and request bodies. A URL-shaped
// mock misses both thrown conversions and Vitest's former "undefined" payload.
describe('Vitest/jsdom binary bridge used by media tests', () => {
  it.each(['Blob', 'File', 'slice', 'empty', 'Node Blob'])(
    'preserves %s object-URL bytes, MIME type, and revocation',
    async (kind) => {
      const bytes = new Uint8Array([0, 65, 127, 255]);
      const options = { type: 'application/octet-stream' };
      const blobs = {
        Blob: new Blob([bytes], options),
        File: new File([bytes], 'binary.dat', options),
        slice: new Blob([bytes]).slice(1, 3, options.type),
        empty: new Blob([], options),
        'Node Blob': new NodeBlob([bytes], options),
      };
      const expected =
        kind === 'slice'
          ? [65, 127]
          : kind === 'empty'
            ? []
            : [0, 65, 127, 255];
      const url = URL.createObjectURL(blobs[kind]);
      try {
        const stored = resolveObjectURL(url);
        expect(stored?.type).toBe('application/octet-stream');
        expect([...new Uint8Array(await stored.arrayBuffer())]).toEqual(
          expected,
        );
      } finally {
        URL.revokeObjectURL(url);
      }
      expect(resolveObjectURL(url)).toBeUndefined();
    },
  );

  it.each(['Blob', 'File'])('preserves a %s Request body', async (kind) => {
    const bytes = new Uint8Array([0, 65, 127, 255]);
    const options = { type: 'application/octet-stream' };
    const body =
      kind === 'File'
        ? new File([bytes], 'binary.dat', options)
        : new Blob([bytes], options);
    const request = new Request('https://example.test/upload', {
      method: 'POST',
      body,
    });
    expect(request.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([
      0, 65, 127, 255,
    ]);
  });

  it('preserves multipart text and File bytes, filename, and MIME type', async () => {
    const form = new FormData();
    form.append('caption', 'binary preview');
    form.append(
      'attachment',
      new File([new Uint8Array([0, 65, 127, 255])], 'binary.dat', {
        type: 'application/octet-stream',
      }),
    );
    const request = new Request('https://example.test/upload', {
      method: 'POST',
      body: form,
    });
    // Inspect what the bridge actually sends. Node's response-side formData()
    // parser separately uses global File, which belongs to jsdom in this realm.
    const boundary = request.headers.get('content-type').split('boundary=')[1];
    const expected = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nbinary preview\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="binary.dat"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      Buffer.from([0, 65, 127, 255]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    expect(Buffer.from(await request.arrayBuffer())).toEqual(expected);
  });

  it('retains jsdom FileReader support for the same File', async () => {
    const file = new File([new Uint8Array([0, 65, 127, 255])], 'binary.dat');
    const result = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
    expect([...new Uint8Array(result)]).toEqual([0, 65, 127, 255]);
  });
});
