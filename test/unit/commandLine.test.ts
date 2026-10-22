import { expect, test } from 'vitest';
import { applyEnvironmentLines, expandPercent, splitCommandLine } from '../../src/debug/commandLine';

test('whitespace separates arguments', () => {
  expect(splitCommandLine('  --a   b\tc ')).toEqual(['--a', 'b', 'c']);
  expect(splitCommandLine('')).toEqual([]);
});

test('quotes group words and are removed', () => {
  expect(splitCommandLine('--level "two words" --x=1')).toEqual(['--level', 'two words', '--x=1']);
  expect(splitCommandLine('a"b c"d')).toEqual(['ab cd']);
});

test('an empty quoted argument is kept', () => {
  expect(splitCommandLine('a "" b')).toEqual(['a', '', 'b']);
});

test('backslashes are literal unless they precede a quote', () => {
  expect(splitCommandLine('C:\\dir\\ "C:\\Program Files\\x"')).toEqual(['C:\\dir\\', 'C:\\Program Files\\x']);
});

test('2n backslashes before a quote give n backslashes and toggle quoting', () => {
  expect(splitCommandLine('"C:\\dir\\\\" next')).toEqual(['C:\\dir\\', 'next']);
});

test('2n+1 backslashes before a quote give n backslashes and a literal quote', () => {
  expect(splitCommandLine('say \\"hi\\"')).toEqual(['say', '"hi"']);
  expect(splitCommandLine('a\\\\\\"b')).toEqual(['a\\"b']);
});

test('a doubled quote inside quotes is a literal quote', () => {
  expect(splitCommandLine('"a""b" c')).toEqual(['a"b', 'c']);
});

test('a doubled quote inside quotes stays in quotes (MSVC runtime since 2008, not CommandLineToArgvW)', () => {
  expect(splitCommandLine('"a""b c"')).toEqual(['a"b c']);
});

test('%VAR% follows ExpandEnvironmentStrings: an unknown name leaves its closing % to open the next one', () => {
  const env = { PATHX: 'p', 'My Var': 'sp' };
  expect(expandPercent('%NOPE%PATHX%', env)).toBe('%NOPEp');
  expect(expandPercent('%My Var%', env)).toBe('sp');
  expect(expandPercent('%%', env)).toBe('%%');
  expect(expandPercent('50%', env)).toBe('50%');
});

test('environment lines read earlier lines whatever the case of their names', () => {
  expect(applyEnvironmentLines(['PATH=a;%PATH%', 'PATH=b;%path%'], { Path: 'proc' })).toEqual({ PATH: 'b;a;proc' });
});

test('%VAR% expands case-insensitively; unknown variables stay literal', () => {
  const env = { Path: 'C:\\bin', HOME: 'C:\\h' };
  expect(expandPercent('%PATH%;C:\\tools', env)).toBe('C:\\bin;C:\\tools');
  expect(expandPercent('%home%\\x', env)).toBe('C:\\h\\x');
  expect(expandPercent('%NOPE%-%PATH%', env)).toBe('%NOPE%-C:\\bin');
  expect(expandPercent('100% sure %%', env)).toBe('100% sure %%');
});

test('environment lines see the variables set before them', () => {
  expect(applyEnvironmentLines(['A=1', 'PATH=x;%PATH%', 'B=%A%2', 'EMPTY=', 'garbage', '=C:=C:\\'], { Path: 'C:\\bin' })).toEqual({
    A: '1', PATH: 'x;C:\\bin', B: '12', EMPTY: '',
  });
});
