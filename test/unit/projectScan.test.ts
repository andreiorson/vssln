import { expect, test } from 'vitest';
import { scanVcxproj, typeFor } from '../../src/solution/projectScan';
import { readFixture } from './helpers';

test('reads per-configuration type', () => {
  const s = scanVcxproj(readFixture('workspace/Game/Game.vcxproj'));
  expect(typeFor(s, 'Release|x64')).toBe('Application');
  expect(s.sources).toBe(2);
  expect(s.headers).toBe(1);
});

test('falls back to unconditioned type', () => {
  const s = scanVcxproj(readFixture('workspace/Core/Math/Math.vcxproj'));
  expect(typeFor(s, 'Debug|x64')).toBe('StaticLibrary');
  expect(s.sources).toBe(3);
  expect(s.headers).toBe(2);
});

test('unknown when nothing matches', () => {
  expect(typeFor(scanVcxproj(readFixture('workspace/Core/Render/Render.vcxproj')), 'Debug|x64')).toBe('unknown');
  expect(typeFor(undefined, 'Release|x64')).toBe('unknown');
});

test('a self-closing PropertyGroup does not swallow the next group', () => {
  const s = scanVcxproj([
    '<Project>',
    '  <PropertyGroup Label="UserMacros" />',
    `  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'" Label="Configuration">`,
    '    <ConfigurationType>DynamicLibrary</ConfigurationType>',
    '  </PropertyGroup>',
    '</Project>',
  ].join('\n'));
  expect(s.types).toEqual({ 'Release|x64': 'DynamicLibrary' });
  expect(s.defaultType).toBeUndefined();
});

test('tolerates spaces around == in conditions', () => {
  const s = scanVcxproj(readFixture('workspace/Tools/Legacy/Legacy.vcxproj'));
  expect(typeFor(s, 'Debug|Win32')).toBe('Utility');
  expect(s.sources).toBe(0);
});
