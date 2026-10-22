import { expect, test } from 'vitest';
import { readProjectReferences, ReferenceContext, ReferenceFs } from '../../src/solution/projectReferences';

const DEPS_GUID = '{A1000000-0000-0000-0000-00000000000D}';

/** Files by absolute path; a folder exists when a file lies in it. */
function fs(files: Record<string, string>): ReferenceFs & { reads: string[] } {
  const lower = new Map(Object.entries(files).map(([p, t]) => [p.toLowerCase(), t]));
  const reads: string[] = [];
  return {
    reads,
    async readText(p) {
      reads.push(p);
      return lower.get(p.toLowerCase());
    },
    async exists(p) {
      const k = p.toLowerCase().replace(/\\$/, '');
      return lower.has(k) || [...lower.keys()].some(f => f.startsWith(`${k}\\`));
    },
  };
}

const ctx = (over: Partial<ReferenceContext> = {}): ReferenceContext => ({
  projectPath: 'C:\\s\\Core\\Platform\\Platform.vcxproj',
  solutionPath: 'C:\\s\\Engine.sln',
  configuration: 'Release',
  platform: 'x64',
  env: {},
  ...over,
});

const project = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props" />
${body}
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.targets" />
</Project>`;
const sheet = (body: string) => `<?xml version="1.0" encoding="utf-8"?>\n<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n${body}\n</Project>`;
const reference = (include: string, guid?: string, attrs = '') =>
  `<ItemGroup><ProjectReference Include="${include}"${attrs}>${guid ? `<Project>${guid}</Project>` : ''}</ProjectReference></ItemGroup>`;

const paths = (refs: { path?: string }[]) => refs.map(r => r.path);

test('a reference in the project resolves against the project folder and keeps its project guid', async () => {
  const files = { 'C:\\s\\Core\\Platform\\Platform.vcxproj': project(reference('..\\..\\Tools\\Deps\\Deps.vcxproj', DEPS_GUID)) };
  expect(await readProjectReferences(ctx(), fs(files))).toEqual([
    { include: '..\\..\\Tools\\Deps\\Deps.vcxproj', path: 'C:\\s\\Tools\\Deps\\Deps.vcxproj', guid: DEPS_GUID },
  ]);
});

test('a reference added by an imported sheet counts, relative to the project, and MSBuildThisFileDirectory is the sheet', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project('<ImportGroup Label="PropertySheets"><Import Project="$(SolutionDir)Build\\Common.props" /></ImportGroup>'),
    'C:\\s\\Build\\Common.props': sheet(`${reference('..\\Math\\Math.vcxproj')}${reference('$(MSBuildThisFileDirectory)..\\Tools\\Deps\\Deps.vcxproj')}`),
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\Core\\Math\\Math.vcxproj', 'C:\\s\\Tools\\Deps\\Deps.vcxproj']);
});

test('imports nest, and an import path may use properties defined by earlier sheets', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project('<Import Project="..\\..\\Build\\Root.props" />'),
    'C:\\s\\Build\\Root.props': sheet('<PropertyGroup><SheetsDir>$(MSBuildThisFileDirectory)sheets\\</SheetsDir></PropertyGroup><Import Project="$(SheetsDir)conan.props" />'),
    'C:\\s\\Build\\sheets\\conan.props': sheet('<PropertyGroup><ConanProject>$(SolutionDir)Tools\\Deps\\Deps.vcxproj</ConanProject></PropertyGroup>' + reference('$(ConanProject)')),
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\Tools\\Deps\\Deps.vcxproj']);
});

test('items take the final value of a property, as MSBuild evaluates items after all properties', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project(`<PropertyGroup><Pkg>A</Pkg></PropertyGroup>${reference('$(SolutionDir)$(Pkg)\\$(Pkg).vcxproj')}<PropertyGroup><Pkg>B</Pkg></PropertyGroup>`),
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\B\\B.vcxproj']);
});

test('conditions follow the project configuration of the build', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project(
      `<ImportGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'"><Import Project="debug.props" /></ImportGroup>
       <ImportGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'"><Import Project="release.props" /></ImportGroup>
       <ItemGroup Condition=" '$(Configuration)' != 'Release' and '$(Platform)' == 'x64' ">${reference('..\\D\\D.vcxproj').replace(/<\/?ItemGroup>/g, '')}</ItemGroup>`,
    ),
    'C:\\s\\Core\\Platform\\debug.props': sheet(reference('..\\Debug\\Debug.vcxproj')),
    'C:\\s\\Core\\Platform\\release.props': sheet(reference('..\\Release\\Release.vcxproj')),
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\Core\\Release\\Release.vcxproj']);
  expect(paths(await readProjectReferences(ctx({ configuration: 'Debug' }), fs(files)))).toEqual(['C:\\s\\Core\\Debug\\Debug.vcxproj', 'C:\\s\\Core\\D\\D.vcxproj']);
});

test('an item condition sees the final properties and the project name', async () => {
  const common = sheet(`<ItemGroup Condition="'$(MSBuildProjectName)' != 'Deps'">${reference('$(SolutionDir)Tools\\Deps\\Deps.vcxproj').replace(/<\/?ItemGroup>/g, '')}</ItemGroup>`);
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project('<Import Project="$(SolutionDir)Build\\Common.props" />'),
    'C:\\s\\Tools\\Deps\\Deps.vcxproj': project('<Import Project="$(SolutionDir)Build\\Common.props" />'),
    'C:\\s\\Build\\Common.props': common,
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\Tools\\Deps\\Deps.vcxproj']);
  expect(await readProjectReferences(ctx({ projectPath: 'C:\\s\\Tools\\Deps\\Deps.vcxproj' }), fs(files))).toEqual([]);
});

test('Directory.Build.props above the project is imported where Microsoft.Cpp.Default.props is', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project(reference('$(Shared)Math.vcxproj')),
    'C:\\s\\Directory.Build.props': sheet('<PropertyGroup><Shared>$(MSBuildThisFileDirectory)Core\\Math\\</Shared></PropertyGroup><Import Project="conan.props" />'),
    'C:\\s\\conan.props': sheet(reference('Tools\\Deps\\Deps.vcxproj')),
  };
  // Items resolve against the project folder wherever they are written.
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\Core\\Platform\\Tools\\Deps\\Deps.vcxproj', 'C:\\s\\Core\\Math\\Math.vcxproj']);
  const off = {
    ...files,
    'C:\\s\\Core\\Platform\\Platform.vcxproj': sheet('<PropertyGroup><ImportDirectoryBuildProps>false</ImportDirectoryBuildProps></PropertyGroup><Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props" />'),
  };
  expect(await readProjectReferences(ctx(), fs(off))).toEqual([]);
});

test('Exists conditions, missing sheets and import cycles', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project(
      `<Import Project="$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props')" />
       <Import Project="$(SolutionDir)out\\generated\\conandeps.props" />
       <Import Project="a.props" Condition="Exists('a.props') And !Exists('missing.props')" />`,
    ),
    'C:\\s\\Core\\Platform\\a.props': sheet(`<Import Project="b.props" />${reference('..\\A\\A.vcxproj')}`),
    'C:\\s\\Core\\Platform\\b.props': sheet(`<Import Project="a.props" />${reference('..\\B\\B.vcxproj')}`),
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\Core\\B\\B.vcxproj', 'C:\\s\\Core\\A\\A.vcxproj']);
});

test('property functions for finding sheets above a folder', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project(
      `<PropertyGroup><Root>$([MSBuild]::GetDirectoryNameOfFileAbove($(MSBuildProjectDirectory), root.marker))</Root></PropertyGroup>
       <Import Project="$([MSBuild]::GetPathOfFileAbove('conan.props', '$(MSBuildThisFileDirectory)'))" />
       ${reference('$([System.IO.Path]::Combine($(Root), Tools, Deps, Deps.vcxproj))')}
       ${reference("$([MSBuild]::NormalizePath('$(Root)', 'Core', 'Math', 'Math.vcxproj'))")}`,
    ),
    'C:\\s\\root.marker': '',
    'C:\\s\\Core\\conan.props': sheet(reference('$([MSBuild]::NormalizeDirectory($(Root), Conan))Conan.vcxproj')),
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual([
    'C:\\s\\Conan\\Conan.vcxproj',
    'C:\\s\\Tools\\Deps\\Deps.vcxproj',
    'C:\\s\\Core\\Math\\Math.vcxproj',
  ]);
});

test('a reference that needs MSBuild keeps its include and guid without a path', async () => {
  const files = { 'C:\\s\\Core\\Platform\\Platform.vcxproj': project(reference('$(Pkg.Replace(x, y))\\Deps.vcxproj', DEPS_GUID) + reference('@(Other)')) };
  expect(await readProjectReferences(ctx(), fs(files))).toEqual([
    { include: '$(Pkg.Replace(x, y))\\Deps.vcxproj', guid: DEPS_GUID },
    { include: '@(Other)' },
  ]);
});

test('environment variables are properties; global properties win over the project', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project(
      `<PropertyGroup><Configuration>Debug</Configuration><Flavor>Project</Flavor></PropertyGroup>${reference('$(CONAN_HOME)\\$(Configuration)\\$(Flavor).vcxproj')}`,
    ),
  };
  const refs = await readProjectReferences(ctx({ env: { conan_home: 'D:\\conan' }, properties: { Flavor: 'Global' } }), fs(files));
  expect(paths(refs)).toEqual(['D:\\conan\\Release\\Global.vcxproj']);
});

test('Choose takes the first true When, else Otherwise', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project(`<Choose>
      <When Condition="'$(Platform)'=='Win32'"><ItemGroup><ProjectReference Include="..\\W\\W.vcxproj" /></ItemGroup></When>
      <When Condition="'$(Platform)'=='x64'"><PropertyGroup><P>X</P></PropertyGroup></When>
      <Otherwise><ItemGroup><ProjectReference Include="..\\O\\O.vcxproj" /></ItemGroup></Otherwise>
    </Choose>${reference('..\\$(P)\\$(P).vcxproj')}`),
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\Core\\X\\X.vcxproj']);
});

test('items inside targets, comments and Remove', async () => {
  const files = {
    'C:\\s\\Core\\Platform\\Platform.vcxproj': project(`<!-- ${reference('..\\C\\C.vcxproj')} -->
      <Target Name="T">${reference('..\\T\\T.vcxproj')}</Target>
      ${reference('..\\A\\A.vcxproj;..\\B\\B.vcxproj')}
      <ItemGroup><ProjectReference Remove="..\\A\\A.vcxproj" /></ItemGroup>
      ${reference('..\\b\\b.vcxproj')}`),
  };
  expect(paths(await readProjectReferences(ctx(), fs(files)))).toEqual(['C:\\s\\Core\\B\\B.vcxproj']);
});

test('a missing or broken project has no references', async () => {
  expect(await readProjectReferences(ctx(), fs({}))).toEqual([]);
  expect(await readProjectReferences(ctx(), fs({ 'C:\\s\\Core\\Platform\\Platform.vcxproj': '<Project><ItemGroup>' }))).toEqual([]);
});
