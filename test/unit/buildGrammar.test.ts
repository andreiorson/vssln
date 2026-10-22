import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';

interface Pattern { match: string; name: string }
const grammar: { scopeName: string; patterns: Pattern[] } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'syntaxes', 'vssln-build.tmLanguage.json'), 'utf8'),
);

/** Approximates TextMate: the earliest match in the line wins, ties go to the first pattern. */
function firstToken(line: string): { scope: string; text: string } | undefined {
  let best: { index: number; scope: string; text: string } | undefined;
  for (const p of grammar.patterns) {
    const m = new RegExp(p.match).exec(line);
    if (m && (!best || m.index < best.index)) best = { index: m.index, scope: p.name, text: m[0] };
  }
  return best && { scope: best.scope, text: best.text };
}

test('every pattern compiles', () => {
  expect(grammar.scopeName).toBe('source.vssln-build');
  for (const p of grammar.patterns) expect(() => new RegExp(p.match)).not.toThrow();
});

test('errors are red, only the error and its code', () => {
  expect(firstToken('C:\\a\\v.cpp(4,1): error C1189: #error: boom [C:\\a\\Math.vcxproj]')).toEqual({ scope: 'token.error-token', text: 'error C1189' });
  expect(firstToken('LINK : fatal error LNK1104: cannot open file [C:\\a\\G.vcxproj]')).toEqual({ scope: 'token.error-token', text: 'fatal error LNK1104' });
  expect(firstToken('EXEC : error : failed [C:\\a\\S.vcxproj]')).toEqual({ scope: 'token.error-token', text: 'error' });
});

test('warnings are yellow', () => {
  expect(firstToken('C:\\a\\m.cpp(3): warning C4100: unused [C:\\a\\M.vcxproj]')).toEqual({ scope: 'token.warn-token', text: 'warning C4100' });
});

test('project results and the final result', () => {
  expect(firstToken('Math: FAILED')).toEqual({ scope: 'token.error-token', text: 'Math: FAILED' });
  expect(firstToken('Build FAILED.')).toEqual({ scope: 'token.error-token', text: 'Build FAILED.' });
  expect(firstToken('Platform: succeeded')).toEqual({ scope: 'markup.inserted', text: 'Platform: succeeded' });
  expect(firstToken('Build succeeded.')).toEqual({ scope: 'markup.inserted', text: 'Build succeeded.' });
  expect(firstToken('Build stopped.')).toEqual({ scope: 'token.warn-token', text: 'Build stopped.' });
  expect(firstToken('Rebuild Engine.sln (Release|x64)')).toEqual({ scope: 'token.info-token', text: 'Rebuild Engine.sln (Release|x64)' });
});

test('summary counts and ordinary lines stay plain', () => {
  expect(firstToken('    0 Error(s)')).toBeUndefined();
  expect(firstToken('    1 Warning(s)')).toBeUndefined();
  expect(firstToken('Game.vcxproj -> C:\\out\\Game.exe')).toBeUndefined();
  expect(firstToken('Time Elapsed 00:00:02.71')).toBeUndefined();
});
