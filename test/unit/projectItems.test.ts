import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { parseProjectItems } from '../../src/solution/projectItems';

const ctx = { projectPath: 'C:\\s\\P\\P.vcxproj', solutionPath: 'C:\\s\\S.sln' };

function project(items: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Release|x64">
      <Configuration>Release</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <ItemDefinitionGroup>
    <ClCompile>
      <WarningLevel>Level3</WarningLevel>
    </ClCompile>
  </ItemDefinitionGroup>
  <ItemGroup />
${items}
</Project>`;
}

function filtersFile(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n${body}\n</Project>`;
}

test('items of every file type, without configurations, references and definitions', () => {
  const r = parseProjectItems(project(`  <ItemGroup>
    <ClCompile Include="main.cpp" />
    <ClCompile Include="pch.cpp">
      <PrecompiledHeader>Create</PrecompiledHeader>
    </ClCompile>
    <ClInclude Include="pch.h" />
    <None Include="readme.md" />
    <ResourceCompile Include="app.rc" />
    <ProjectReference Include="..\\Core\\Core.vcxproj">
      <Project>{11111111-1111-1111-1111-111111111111}</Project>
    </ProjectReference>
  </ItemGroup>`), undefined, ctx);
  expect(r.items.map(i => i.itemType)).toEqual(['ClCompile', 'ClCompile', 'ClInclude', 'None', 'ResourceCompile']);
  expect(r.items.map(i => i.path)).toEqual(['C:\\s\\P\\main.cpp', 'C:\\s\\P\\pch.cpp', 'C:\\s\\P\\pch.h', 'C:\\s\\P\\readme.md', 'C:\\s\\P\\app.rc']);
  expect(r.items[0]).toEqual({ itemType: 'ClCompile', include: 'main.cpp', path: 'C:\\s\\P\\main.cpp' });
});

test('include lists, duplicates and conditions', () => {
  const r = parseProjectItems(project(`  <ItemGroup>
    <ClCompile Include="a.cpp;b.cpp" />
  </ItemGroup>
  <ItemGroup Condition="'$(Configuration)'=='Debug'">
    <ClCompile Include="a.cpp" />
    <ClCompile Include=".\\A.cpp" />
    <ClCompile Include="debug.cpp" />
  </ItemGroup>`), undefined, ctx);
  expect(r.items.map(i => i.include)).toEqual(['a.cpp', 'b.cpp', 'debug.cpp']);
});

test('project references are read as resolved paths and are not files', () => {
  const r = parseProjectItems(project(`  <ItemGroup>
    <ProjectReference Include="..\\Core\\Core.vcxproj">
      <Project>{11111111-1111-1111-1111-111111111111}</Project>
    </ProjectReference>
    <ProjectReference Include="$(SolutionDir)Deps\\Conan.vcxproj" />
    <ClCompile Include="a.cpp" />
  </ItemGroup>
  <ItemGroup Condition="'$(Configuration)'=='Debug'">
    <ProjectReference Include="..\\core\\core.vcxproj" />
    <ProjectReference Include="$(Unknown)\\X.vcxproj" />
  </ItemGroup>`), undefined, ctx);
  expect(r.references).toEqual(['C:\\s\\Core\\Core.vcxproj', 'C:\\s\\Deps\\Conan.vcxproj']);
  // $(Unknown) needs MSBuild: the project has references this reading cannot see.
  expect(r.unresolvedReferences).toBe(true);
  expect(r.items.map(i => i.include)).toEqual(['a.cpp']);
  expect(parseProjectItems(project(''), undefined, ctx)).toMatchObject({ references: [], unresolvedReferences: false });
});

test('commented-out items and filters are not read', () => {
  const r = parseProjectItems(project(`  <ItemGroup>
    <!-- <ClCompile Include="old.cpp" /> -->
    <ClCompile Include="a.cpp" />
  </ItemGroup>`), filtersFile(`  <ItemGroup>
    <!-- <Filter Include="Old" /> -->
    <ClCompile Include="a.cpp"><!-- <Filter>Old</Filter> --><Filter>New</Filter></ClCompile>
  </ItemGroup>`), ctx);
  expect(r.items).toEqual([{ itemType: 'ClCompile', include: 'a.cpp', path: 'C:\\s\\P\\a.cpp', filter: 'New' }]);
  expect(r.filters).toEqual(['New']);
});

test('a > inside an attribute value does not hide the items after it', () => {
  const r = parseProjectItems(project(`  <ItemGroup Condition="'$(X)'>'1'">
    <ClCompile Include="a.cpp" Condition="'$(X)'>'1'" /><ClCompile Include="b.cpp" /><ClCompile Include='c.cpp'><X>1</X></ClCompile>
  </ItemGroup>`), undefined, ctx);
  expect(r.items.map(i => i.include)).toEqual(['a.cpp', 'b.cpp', 'c.cpp']);
});

test('references, folders and the item groups of targets are not files', () => {
  const r = parseProjectItems(project(`  <ItemGroup>
    <SDKReference Include="Microsoft.VCLibs, Version=14.0" />
    <COMReference Include="Lib" />
    <COMFileReference Include="lib.tlb" />
    <NativeReference Include="Native" />
    <Folder Include="assets\\" />
    <ClCompile Include="a.cpp" />
  </ItemGroup>
  <Target Name="After" AfterTargets="Build">
    <ItemGroup>
      <Out Include="$(OutDir)x.dll" />
      <Gen Include="gen.txt" />
    </ItemGroup>
  </Target>`), undefined, ctx);
  expect(r.items.map(i => i.include)).toEqual(['a.cpp']);
});

test('a bad character reference does not throw', () => {
  // Kept as written; its ";" then separates items, as for any include list.
  const r = parseProjectItems(project('  <ItemGroup>\n    <None Include="a&#x110000;b.txt" />\n  </ItemGroup>'), undefined, ctx);
  expect(r.items.map(i => i.include)).toEqual(['a&#x110000', 'b.txt']);
});

test('many items and filters are read in linear time', () => {
  const n = 50000;
  const vcxproj = project(`  <ItemGroup>\n${Array.from({ length: n }, (_, i) => `    <ClCompile Include="f${i}.cpp" />`).join('\n')}\n  </ItemGroup>`);
  const filters = filtersFile(`  <ItemGroup>\n${Array.from({ length: n }, (_, i) => `    <ClCompile Include="f${i}.cpp"><Filter>F${i % 5000}</Filter></ClCompile>`).join('\n')}\n  </ItemGroup>`);
  const start = Date.now();
  const r = parseProjectItems(vcxproj, filters, ctx);
  expect(r.filters).toHaveLength(5000);
  expect(Date.now() - start).toBeLessThan(1500);
});

test('macros, entities and escapes', () => {
  const r = parseProjectItems(project(`  <ItemGroup>
    <ClInclude Include="$(SolutionDir)inc\\x.h" />
    <ClInclude Include="$(projectdir)y.h" />
    <ClInclude Include="$(MSBuildProjectDirectory)\\w.h" />
    <ClInclude Include="$(MSBuildThisFileDirectory)$(ProjectName).h" />
    <ClInclude Include="..\\shared\\z.h" />
    <None Include="a&amp;b.txt" />
    <None Include="my%20file.txt" />
    <ClInclude Include="$(Other)\\q.h" />
    <ClCompile Include="src\\*.cpp" />
  </ItemGroup>`), undefined, ctx);
  expect(r.items.map(i => i.path)).toEqual([
    'C:\\s\\inc\\x.h',
    'C:\\s\\P\\y.h',
    'C:\\s\\P\\w.h',
    'C:\\s\\P\\P.h',
    'C:\\s\\shared\\z.h',
    'C:\\s\\P\\a&b.txt',
    'C:\\s\\P\\my file.txt',
    undefined,
    undefined,
  ]);
  expect(r.items.slice(-2).map(i => i.include)).toEqual(['$(Other)\\q.h', 'src\\*.cpp']);
});

test('filters by path, ignoring spelling', () => {
  const vcxproj = project(`  <ItemGroup>
    <ClCompile Include="src\\a.cpp" />
    <ClCompile Include="main.cpp" />
    <ClInclude Include="b.h" />
  </ItemGroup>`);
  const filters = filtersFile(`  <ItemGroup>
    <Filter Include="Source Files">
      <UniqueIdentifier>{4FC737F1-C7A5-4376-A066-2A32D752A2FF}</UniqueIdentifier>
    </Filter>
    <Filter Include="Source Files\\Sub" />
    <Filter Include="Empty" />
  </ItemGroup>
  <ItemGroup>
    <ClCompile Include=".\\src\\A.cpp">
      <Filter>Source Files\\Sub</Filter>
    </ClCompile>
    <ClInclude Include="b.h">
      <Filter>Undeclared</Filter>
    </ClInclude>
    <ClCompile Include="gone.cpp">
      <Filter>Gone</Filter>
    </ClCompile>
  </ItemGroup>`);
  const r = parseProjectItems(vcxproj, filters, ctx);
  expect(r.items.map(i => i.filter)).toEqual(['Source Files\\Sub', undefined, 'Undeclared']);
  expect(r.filters).toEqual(['Source Files', 'Source Files\\Sub', 'Empty', 'Undeclared']);
});

test('no or broken filters file', () => {
  const vcxproj = project('  <ItemGroup>\n    <ClCompile Include="a.cpp" />\n  </ItemGroup>');
  for (const filters of [undefined, '', '<Project><ItemGroup><ClCompile Include="a.cpp"><Filter>X']) {
    const r = parseProjectItems(vcxproj, filters, ctx);
    expect(r.filters).toEqual([]);
    expect(r.items).toEqual([{ itemType: 'ClCompile', include: 'a.cpp', path: 'C:\\s\\P\\a.cpp' }]);
  }
});

test('the sample Render project', () => {
  const dir = path.join(__dirname, '..', '..', 'samples', 'Engine', 'Graphics', 'Render');
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  const r = parseProjectItems(read('Render.vcxproj'), read('Render.vcxproj.filters'), {
    projectPath: 'C:\\e\\Graphics\\Render\\Render.vcxproj',
    solutionPath: 'C:\\e\\Engine.sln',
  });
  expect(r.filters).toEqual(['Source Files', 'Header Files']);
  expect(r.items.map(i => [i.include, i.filter])).toEqual([
    ['pch.cpp', 'Source Files'],
    ['render.cpp', 'Source Files'],
    ['frame.cpp', 'Source Files'],
    ['pch.h', 'Header Files'],
  ]);
});
