import { expect, test } from 'vitest';
import { debugPropertiesArgs, EnvExec, evaluateDebugProperties, parseDebugProperties } from '../../src/debug/properties';
import { readFixture } from './helpers';

const base = {
  projectPath: 'C:\\src\\Engine\\Game\\Game.vcxproj',
  config: { configuration: 'Release', platform: 'x64' },
  solutionPath: 'C:\\src\\Engine\\Engine.sln',
  targetsFile: 'C:\\ext\\resources\\vssln-debug.targets',
  devEnvDir: 'C:\\VS\\Common7\\IDE\\',
  properties: {},
};

test('arguments evaluate one project in the same context as a solution build', () => {
  expect(debugPropertiesArgs(base)).toEqual([
    'C:\\src\\Engine\\Game\\Game.vcxproj', '-t:VsslnDebugProperties', '-nologo', '-v:minimal',
    '-p:Configuration=Release', '-p:Platform=x64',
    '-p:SolutionDir=C:\\src\\Engine\\', '-p:SolutionPath=C:\\src\\Engine\\Engine.sln', '-p:SolutionName=Engine',
    '-p:SolutionFileName=Engine.sln', '-p:SolutionExt=.sln',
    '-p:DevEnvDir=C:\\VS\\Common7\\IDE\\', '-p:CustomAfterMicrosoftCommonTargets=C:\\ext\\resources\\vssln-debug.targets',
  ]);
  expect(debugPropertiesArgs({ ...base, devEnvDir: '' }).some(a => a.startsWith('-p:DevEnvDir'))).toBe(false);
});

test('msbuild.properties of the settings are passed too, escaped like for builds', () => {
  const args = debugPropertiesArgs({ ...base, properties: { OutDir: 'C:\\o\\', List: 'a;b' } });
  expect(args).toContain('-p:OutDir=C:\\o\\');
  expect(args).toContain('-p:List=a%3Bb');
});

test('paths with separators MSBuild splits on are escaped', () => {
  const args = debugPropertiesArgs({ ...base, solutionPath: 'C:\\a,b\\E.sln', targetsFile: 'C:\\x;y\\t.targets' });
  expect(args).toContain('-p:SolutionDir=C:\\a%2Cb\\');
  expect(args).toContain('-p:CustomAfterMicrosoftCommonTargets=C:\\x%3By\\t.targets');
});

test('the spike output is parsed, with backslash-n inside paths kept', () => {
  expect(parseDebugProperties(readFixture('msbuild/debug-props-release.log'))).toEqual({
    targetPath: 'C:\\src\\Engine\\out\\x64\\Release\\Game.exe',
    command: 'C:\\src\\Engine\\out\\x64\\Release\\Game.exe',
    arguments: '--level "two words" --x=1',
    workingDirectory: 'C:\\src\\Engine\\out\\x64\\Release\\',
    environment: ['GAME_MODE=sample', 'PATH=C:\\src\\Engine\\tools;%PATH%', 'EMPTY=', 'NINJA=C:\\ninja\\bin;D:\\new'],
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

test('a timeout says so instead of printing the command line', async () => {
  const slow: EnvExec = async () => {
    throw Object.assign(new Error('Command failed: C:\\VS\\MSBuild.exe a b c'), { killed: true });
  };
  expect((await evaluateDebugProperties({ exec: slow, msbuildPath: 'm', env: {} }, [])).problem).toBe('Reading the launch settings with MSBuild did not finish in 120 s.');
});
