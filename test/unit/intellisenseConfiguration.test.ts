import { expect, test } from 'vitest';
import { toConfiguration } from '../../src/intellisense/configuration';

const SYS = ['C:\\VC\\include', 'C:\\SDK\\ucrt'];

test('includes in order, then the system ones; defines with quoted values; forced includes', () => {
  const c = toConfiguration('/c /IC:\\a /I "C:\\Program Files\\b" /I C:\\c /W3 /D NDEBUG /D "ENGINE_FLAVOR=\\"\\"" /DX#1 /FIforced.h /FI "C:\\with space\\f.h" /Yu"pch.h" /Fp"C:\\o\\P.pch" /Fo"C:\\o\\\\" /EHsc /std:c++20', SYS, 'x64');
  expect(c).toEqual({
    includePath: ['C:\\a', 'C:\\Program Files\\b', 'C:\\c', 'C:\\VC\\include', 'C:\\SDK\\ucrt'],
    defines: ['NDEBUG', 'ENGINE_FLAVOR=""', 'X=1'],
    forcedInclude: ['forced.h', 'C:\\with space\\f.h'],
    standard: 'c++20',
    intelliSenseMode: 'windows-msvc-x64',
  });
});

test('external include directories are include directories too', () => {
  expect(toConfiguration('/I C:\\a /external:I C:\\ext /external:IC:\\ext2 /external:W3', [], 'x64').includePath).toEqual(['C:\\a', 'C:\\ext', 'C:\\ext2']);
});

test('/U removes a define given before it; an include already listed is not repeated', () => {
  const c = toConfiguration('/D A /D B=2 /U A /I C:\\VC\\INCLUDE', SYS, 'x64');
  expect(c.defines).toEqual(['B=2']);
  expect(c.includePath).toEqual(['C:\\VC\\INCLUDE', 'C:\\SDK\\ucrt']);
});

test('language standards of C++ and C', () => {
  expect(toConfiguration('/std:c++latest', [], 'x64').standard).toBe('c++23');
  expect(toConfiguration('/std:c++17', [], 'x64').standard).toBe('c++17');
  expect(toConfiguration('/std:c++14', [], 'x64').standard).toBe('c++14');
  expect(toConfiguration('/c', [], 'x64').standard).toBe('c++14');
  expect(toConfiguration('/c /TC', [], 'x64').standard).toBe('c17');
  expect(toConfiguration('/c /std:c11', [], 'x64', 'C:\\p\\a.c').standard).toBe('c11');
  expect(toConfiguration('/c', [], 'x64', 'C:\\p\\a.c').standard).toBe('c17');
  // /TP compiles .c files as C++.
  expect(toConfiguration('/c /TP /std:c++20', [], 'x64', 'C:\\p\\a.c').standard).toBe('c++20');
});

test('C++23 preview and standards newer than cpptools knows map to c++23', () => {
  expect(toConfiguration('/std:c++23preview', [], 'x64').standard).toBe('c++23');
  expect(toConfiguration('/std:c++26', [], 'x64').standard).toBe('c++23');
});

test('relative include directories and forced includes are relative to the project folder, as cl sees them', () => {
  const c = toConfiguration('/Iinc /I ..\\..\\external\\include /external:Ivendor /I C:\\abs /FIpre.h /FI C:\\abs\\f.h', [], 'x64', undefined, 'C:\\repo\\src\\Game');
  expect(c.includePath).toEqual(['C:\\repo\\src\\Game\\inc', 'C:\\repo\\external\\include', 'C:\\repo\\src\\Game\\vendor', 'C:\\abs']);
  expect(c.forcedInclude).toEqual(['C:\\repo\\src\\Game\\pre.h', 'C:\\abs\\f.h']);
});

test('the IntelliSense mode follows the platform', () => {
  expect(toConfiguration('', [], 'Win32').intelliSenseMode).toBe('windows-msvc-x86');
  expect(toConfiguration('', [], 'x86').intelliSenseMode).toBe('windows-msvc-x86');
  expect(toConfiguration('', [], 'ARM64').intelliSenseMode).toBe('windows-msvc-arm64');
  expect(toConfiguration('', [], 'ARM').intelliSenseMode).toBe('windows-msvc-arm');
  expect(toConfiguration('', [], 'x64').intelliSenseMode).toBe('windows-msvc-x64');
});
