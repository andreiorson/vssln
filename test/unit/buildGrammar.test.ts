import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { BUILD_OUTPUT_LANGUAGE } from '../../src/build/outputLanguage';

interface Pattern { match: string; name?: string; captures?: Record<string, { name: string }> }
const root = path.join(__dirname, '..', '..');
const grammar: { scopeName: string; patterns: Pattern[] } = JSON.parse(fs.readFileSync(path.join(root, 'syntaxes', 'vssln-build.tmLanguage.json'), 'utf8'));

/**
 * Approximates TextMate: from the current position the earliest match wins (ties: first pattern), scanning goes on
 * after it; "^" only matches at the start of the line. Returns every scoped piece of text.
 */
function tokens(line: string): { scope: string; text: string }[] {
  const out: { scope: string; text: string }[] = [];
  let pos = 0;
  while (pos <= line.length) {
    let best: { index: number; m: RegExpExecArray; p: Pattern } | undefined;
    for (const p of grammar.patterns) {
      const re = new RegExp(p.match, 'g');
      re.lastIndex = pos;
      const m = re.exec(line);
      if (m && m[0].length > 0 && (!best || m.index < best.index)) best = { index: m.index, m, p };
    }
    if (!best) break;
    if (best.p.name) out.push({ scope: best.p.name, text: best.m[0] });
    for (const [group, capture] of Object.entries(best.p.captures ?? {})) {
      if (best.m[Number(group)]) out.push({ scope: capture.name, text: best.m[Number(group)] });
    }
    pos = best.index + best.m[0].length;
  }
  return out;
}

test('every pattern compiles', () => {
  expect(grammar.scopeName).toBe('source.vssln-build');
  for (const p of grammar.patterns) expect(() => new RegExp(p.match)).not.toThrow();
});

test('the package contributes this grammar for the output channel language', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(pkg.contributes.languages.map((l: { id: string }) => l.id)).toContain(BUILD_OUTPUT_LANGUAGE);
  const g = pkg.contributes.grammars.find((x: { language: string }) => x.language === BUILD_OUTPUT_LANGUAGE);
  expect(g.scopeName).toBe(grammar.scopeName);
  expect(fs.existsSync(path.join(root, g.path))).toBe(true);
});

test('only the error and its code are red, not words in the message', () => {
  expect(tokens('C:\\a\\v.cpp(4,1): error C1189: #error: boom [C:\\a\\Math.vcxproj]')).toEqual([{ scope: 'token.error-token', text: 'error C1189' }]);
  expect(tokens('LINK : fatal error LNK1104: cannot open file [C:\\a\\G.vcxproj]')).toEqual([{ scope: 'token.error-token', text: 'fatal error LNK1104' }]);
  expect(tokens('EXEC : error : failed with error: 5 [C:\\a\\S.vcxproj]')).toEqual([{ scope: 'token.error-token', text: 'error' }]);
  expect(tokens('cl : command line error D8016: bad [C:\\a\\M.vcxproj]')).toEqual([{ scope: 'token.error-token', text: 'error D8016' }]);
});

test('warnings are yellow, only the warning and its code', () => {
  expect(tokens('C:\\a\\m.cpp(3): warning C4100: unused, see warning: x [C:\\a\\M.vcxproj]')).toEqual([{ scope: 'token.warn-token', text: 'warning C4100' }]);
});

test('project results, the final result and start failures', () => {
  expect(tokens('Math: FAILED')).toEqual([{ scope: 'token.error-token', text: 'Math: FAILED' }]);
  expect(tokens('Build FAILED.')).toEqual([{ scope: 'token.error-token', text: 'Build FAILED.' }]);
  expect(tokens('Platform: succeeded')).toEqual([{ scope: 'markup.inserted', text: 'Platform: succeeded' }]);
  expect(tokens('Build succeeded.')).toEqual([{ scope: 'markup.inserted', text: 'Build succeeded.' }]);
  expect(tokens('Build stopped.')).toEqual([{ scope: 'token.warn-token', text: 'Build stopped.' }]);
  expect(tokens('Rebuild Engine.sln (Release|x64)')).toEqual([{ scope: 'token.info-token', text: 'Rebuild Engine.sln (Release|x64)' }]);
  expect(tokens('MSBuild could not start: spawn ENOENT')).toEqual([{ scope: 'token.error-token', text: 'MSBuild could not start: spawn ENOENT' }]);
  expect(tokens('The build failed to run: boom')).toEqual([{ scope: 'token.error-token', text: 'The build failed to run: boom' }]);
});

test('numbered project lines: the header is blue, results keep their colours, progress stays plain', () => {
  const header = '2>------ Rebuild All started: Project: Render, Configuration: Release x64 ------';
  expect(tokens(header)).toEqual([{ scope: 'token.info-token', text: header }]);
  expect(tokens('3>Math: FAILED')).toEqual([{ scope: 'token.error-token', text: '3>Math: FAILED' }]);
  expect(tokens('12>Platform: succeeded')).toEqual([{ scope: 'markup.inserted', text: '12>Platform: succeeded' }]);
  expect(tokens('3>C:\\a\\v.cpp(4,1): error C1189: #error: boom [C:\\a\\Math.vcxproj]')).toEqual([{ scope: 'token.error-token', text: 'error C1189' }]);
  expect(tokens('2>render.cpp')).toEqual([]);
  expect(tokens('2>Render.vcxproj -> C:\\out\\Render.dll')).toEqual([]);
});

test('waves are blue, projects not built because of a failure are yellow', () => {
  expect(tokens('Wave 2/3: Render, MathTests')).toEqual([{ scope: 'token.info-token', text: 'Wave 2/3: Render, MathTests' }]);
  expect(tokens('Not built because Math failed: Render, Game')).toEqual([{ scope: 'token.warn-token', text: 'Not built because Math failed: Render, Game' }]);
  expect(tokens('The project dependencies form a cycle (A → B → A); building the solution in one run.')).toEqual([
    { scope: 'token.warn-token', text: 'The project dependencies form a cycle (A → B → A); building the solution in one run.' },
  ]);
});

test('summary counts and ordinary lines stay plain', () => {
  expect(tokens('    0 Error(s)')).toEqual([]);
  expect(tokens('    1 Warning(s)')).toEqual([]);
  expect(tokens('Game.vcxproj -> C:\\out\\Game.exe')).toEqual([]);
  expect(tokens('Time Elapsed 00:00:02.71')).toEqual([]);
});
