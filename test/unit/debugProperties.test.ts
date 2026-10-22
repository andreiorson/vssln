import { expect, test } from 'vitest';
import { debugPropertiesArgs, EnvExec, evaluateDebugProperties, parseDebugProperties } from '../../src/debug/properties';
import { readFixture } from './helpers';

test('arguments evaluate one project with our targets file', () => {
  expect(debugPropertiesArgs('C:\\src\\Engine\\Game\\Game.vcxproj', { configuration: 'Release', platform: 'x64' }, 'C:\\src\\Engine', 'C:\\ext\\resources\\vssln-debug.targets', 'C:\\VS\\Common7\\IDE\\')).toEqual([
    'C:\\src\\Engine\\Game\\Game.vcxproj', '-t:VsslnDebugProperties', '-nologo', '-v:minimal',
    '-p:Configuration=Release', '-p:Platform=x64', '-p:SolutionDir=C:\\src\\Engine\\',
    '-p:DevEnvDir=C:\\VS\\Common7\\IDE\\', '-p:CustomAfterMicrosoftCommonTargets=C:\\ext\\resources\\vssln-debug.targets',
  ]);
  expect(debugPropertiesArgs('p.vcxproj', { configuration: 'D', platform: 'x' }, 'C:\\s\\', 't', '')).not.toContain('-p:DevEnvDir=');
  expect(debugPropertiesArgs('p.vcxproj', { configuration: 'D', platform: 'x' }, 'C:\\s\\', 't', '')).toContain('-p:SolutionDir=C:\\s\\');
});

test('the spike output is parsed', () => {
  expect(parseDebugProperties(readFixture('msbuild/debug-props-release.log'))).toEqual({
    targetPath: 'C:\\src\\Engine\\out\\x64\\Release\\Game.exe',
    command: 'C:\\src\\Engine\\out\\x64\\Release\\Game.exe',
    arguments: '--level "two words" --x=1',
    workingDirectory: 'C:\\src\\Engine\\out\\x64\\Release\\',
    environment: ['GAME_MODE=sample', 'PATH=C:\\src\\Engine\\tools;%PATH%', 'EMPTY='],
    mergeEnvironment: false,
    projectDir: 'C:\\src\\Engine\\Game\\',
    configurationType: 'Application',
  });
});

test('empty values and default merge', () => {
  const p = parseDebugProperties(['VSSLN|TargetPath|C:\\a.exe', 'VSSLN|LocalDebuggerEnvironment|', 'VSSLN|LocalDebuggerMergeEnvironment|true'].join('\r\n'))!;
  expect(p.environment).toEqual([]);
  expect(p.mergeEnvironment).toBe(true);
  expect(p.arguments).toBe('');
});

test('no TargetPath means no properties', () => {
  expect(parseDebugProperties('error MSB4057: The target "VsslnDebugProperties" does not exist')).toBeUndefined();
});

test('evaluation runs MSBuild in English and reports failures with the output tail', async () => {
  const calls: { file: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const ok: EnvExec = async (file, args, env) => {
    calls.push({ file, args, env });
    return { code: 0, stdout: readFixture('msbuild/debug-props-release.log'), stderr: '' };
  };
  const r = await evaluateDebugProperties({ exec: ok, msbuildPath: 'C:\\VS\\MSBuild.exe', env: { PATH: 'p' } }, ['a']);
  expect(r.properties!.configurationType).toBe('Application');
  expect(calls[0]).toEqual({ file: 'C:\\VS\\MSBuild.exe', args: ['a'], env: { PATH: 'p', DOTNET_CLI_UI_LANGUAGE: 'en-US', VSLANG: '1033' } });

  const failing: EnvExec = async () => ({ code: 1, stdout: 'line 1\nline 2\nC:\\p.vcxproj : error MSB4019: imported project not found', stderr: '' });
  const bad = await evaluateDebugProperties({ exec: failing, msbuildPath: 'm', env: {} }, []);
  expect(bad.properties).toBeUndefined();
  expect(bad.problem).toMatch(/MSB4019/);
});
