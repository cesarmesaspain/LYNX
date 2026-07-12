import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { RequestBodyTooLargeError, readRequestBody } from '../../../src/server/dashboard/utils.js';

describe('readRequestBody', () => {
  it('reads bodies below the configured limit', async () => {
    await expect(readRequestBody(Readable.from([Buffer.from('{"ok":true}')]) as never, 32)).resolves.toBe('{"ok":true}');
  });

  it('rejects oversized bodies before buffering them all', async () => {
    await expect(readRequestBody(Readable.from([Buffer.from('0123456789')]) as never, 5)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
