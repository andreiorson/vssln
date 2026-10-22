import { expect, test } from 'vitest';
import { decodeText } from '../../src/util/text';

test('UTF-8 with and without a BOM is read as UTF-8', () => {
  expect(decodeText(Buffer.from('<Project>ä</Project>', 'utf8'))).toBe('<Project>ä</Project>');
  expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x', 'utf8')]))).toBe('﻿x');
});

test('UTF-16 files, as older Visual Studio versions wrote them, are decoded by their BOM', () => {
  expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<Project>ä</Project>', 'utf16le')]))).toBe('<Project>ä</Project>');
  const be = Buffer.from('<P>', 'utf16le').swap16();
  expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('<P>');
});
