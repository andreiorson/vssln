import { expect, test } from 'vitest';
import { diagnosticDetails } from '../../src/build/diagnostics';

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

test('a position range keeps its start', () => {
  expect(diagnosticDetails('C:\\a\\x.cpp(10,5,10,9): error C2065: undeclared [C:\\a\\A.vcxproj]')).toMatchObject({ line: 10, column: 5 });
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

test('a warning of the solution itself lands on the solution', () => {
  expect(diagnosticDetails('C:\\src\\Engine.sln.metaproj : warning MSB4121: not specified [C:\\src\\Engine.sln]')).toMatchObject({
    file: 'C:\\src\\Engine.sln', severity: 'warning', code: 'MSB4121',
  });
});

test('lines that are not diagnostics give nothing', () => {
  expect(diagnosticDetails('Game.vcxproj -> C:\\out\\Game.exe')).toBeUndefined();
});
