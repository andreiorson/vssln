import { expect, test } from 'vitest';
import { diagnosticDetails, diagnosticRange, ProblemsBuffer } from '../../src/build/diagnostics';

test('compiler error with line and column', () => {
  expect(diagnosticDetails('C:\\src\\Core\\Math\\vector.cpp(4,1): error C1189: #error:  "boom" [C:\\src\\Core\\Math\\Math.vcxproj]')).toEqual({
    file: 'C:\\src\\Core\\Math\\vector.cpp', line: 4, column: 1, severity: 'error', code: 'C1189', message: '#error:  "boom"',
  });
});

test('warning with a line only', () => {
  expect(diagnosticDetails('C:\\src\\Game\\main.cpp(12): warning C4100: unused parameter [C:\\src\\Game\\Game.vcxproj]')).toEqual({
    file: 'C:\\src\\Game\\main.cpp', line: 12, severity: 'warning', code: 'C4100', message: 'unused parameter',
  });
});

test('position ranges keep their end', () => {
  expect(diagnosticDetails('C:\\a\\x.cpp(10,5,12,9): error C2065: undeclared [C:\\a\\A.vcxproj]')).toMatchObject({ line: 10, column: 5, endLine: 12, endColumn: 9 });
  expect(diagnosticDetails('C:\\a\\x.cpp(10-12): error C2065: undeclared [C:\\a\\A.vcxproj]')).toMatchObject({ line: 10, endLine: 12 });
  expect(diagnosticDetails('C:\\a\\x.cpp(10,5-9): error C2065: undeclared [C:\\a\\A.vcxproj]')).toMatchObject({ line: 10, column: 5, endLine: 10, endColumn: 9 });
});

test('linker errors are reported on the project file', () => {
  expect(diagnosticDetails('LINK : error LNK2001: unresolved external symbol foo [C:\\src\\Audio\\Audio.vcxproj]')).toEqual({
    file: 'C:\\src\\Audio\\Audio.vcxproj', severity: 'error', code: 'LNK2001', message: 'unresolved external symbol foo',
  });
  expect(diagnosticDetails('C:\\out\\Audio.dll : fatal error LNK1120: 1 unresolved externals [C:\\src\\Audio\\Audio.vcxproj]')).toMatchObject({
    file: 'C:\\src\\Audio\\Audio.vcxproj', code: 'LNK1120',
  });
});

test('diagnostics without a code', () => {
  expect(diagnosticDetails('EXEC : error : the tool failed [C:\\a\\S.vcxproj]')).toEqual({
    file: 'C:\\a\\S.vcxproj', severity: 'error', message: 'the tool failed',
  });
});

test('a relative source path is resolved against the project directory', () => {
  expect(diagnosticDetails('src\\game.cpp(3): error C2143: syntax error [C:\\src\\Game\\Game.vcxproj]')!.file).toBe('C:\\src\\Game\\src\\game.cpp');
});

test('without a project, the solution gives the file and the directory', () => {
  expect(diagnosticDetails('MSBUILD : error MSB4177: Invalid property.', 'C:\\src\\Engine.sln')).toMatchObject({ file: 'C:\\src\\Engine.sln', code: 'MSB4177' });
  expect(diagnosticDetails('src\\x.cpp(3): error C1: bad', 'C:\\src\\Engine.sln')!.file).toBe('C:\\src\\src\\x.cpp');
});

test('a warning of the solution itself lands on the solution', () => {
  expect(diagnosticDetails('C:\\src\\Engine.sln.metaproj : warning MSB4121: not specified [C:\\src\\Engine.sln]')).toMatchObject({
    file: 'C:\\src\\Engine.sln', severity: 'warning', code: 'MSB4121',
  });
});

test('lines that are not diagnostics give nothing', () => {
  expect(diagnosticDetails('Game.vcxproj -> C:\\out\\Game.exe')).toBeUndefined();
});

test('ranges are zero-based; a column alone is an empty range VS Code widens to the word', () => {
  expect(diagnosticRange({ file: 'f', line: 4, column: 7, severity: 'error', message: 'm' })).toEqual({ startLine: 3, startColumn: 6, endLine: 3, endColumn: 6 });
  expect(diagnosticRange({ file: 'f', line: 4, severity: 'error', message: 'm' })).toEqual({ startLine: 3, startColumn: 0, endLine: 3, endColumn: Number.MAX_SAFE_INTEGER });
  expect(diagnosticRange({ file: 'f', line: 10, column: 5, endLine: 12, endColumn: 9, severity: 'error', message: 'm' })).toEqual({ startLine: 9, startColumn: 4, endLine: 11, endColumn: 8 });
  expect(diagnosticRange({ file: 'f', severity: 'error', message: 'm' })).toEqual({ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 });
});

test('the problems buffer drops repeats and groups files ignoring case', () => {
  const buffer = new ProblemsBuffer();
  const d = (file: string, message = 'unused') => ({ file, line: 3, severity: 'warning' as const, code: 'C4100', message });
  expect(buffer.add(d('C:\\a\\h.h'))).toBe(true);
  expect(buffer.add(d('c:\\a\\H.h'))).toBe(false);
  expect(buffer.add(d('C:\\a\\h.h', 'other'))).toBe(true);
  expect(buffer.add({ severity: 'error', message: 'no file' })).toBe(false);
  expect([...buffer.files()].map(([file, list]) => [file, list.map(x => x.message)])).toEqual([['C:\\a\\h.h', ['unused', 'other']]]);
  buffer.clear();
  expect([...buffer.files()]).toEqual([]);
});
