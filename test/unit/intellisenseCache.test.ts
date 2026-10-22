import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { CacheEntry, CacheKey, cacheFileName, cacheKey, fileCacheStore, Hasher, isFresh } from '../../src/intellisense/cache';

const base: CacheKey = {
  msbuildPath: 'C:\\VS\\MSBuild.exe',
  projectPath: 'C:\\s\\P\\P.vcxproj',
  configuration: 'Release',
  platform: 'x64',
  solutionPath: 'C:\\s\\S.sln',
  properties: { A: '1', B: '2' },
  environment: { SDK: 'C:\\sdk' },
  targetsVersion: 1,
};

test('the key changes with every field and not with the order of properties', () => {
  const k = cacheKey(base);
  expect(cacheKey({ ...base, properties: { B: '2', A: '1' } })).toBe(k);
  for (const change of [
    { msbuildPath: 'C:\\VS2\\MSBuild.exe' },
    { projectPath: 'C:\\s\\Q\\Q.vcxproj' },
    { configuration: 'Debug' },
    { platform: 'Win32' },
    { solutionPath: 'C:\\s\\T.sln' },
    { properties: { A: '1', B: '3' } },
    { environment: {} },
    { targetsVersion: 2 },
  ]) {
    expect(cacheKey({ ...base, ...change })).not.toBe(k);
  }
});

test('one cache file per project and configuration, whatever the case of the path', () => {
  const name = cacheFileName('C:\\s\\P\\P.vcxproj', 'Release', 'x64');
  expect(name).toMatch(/^[0-9a-f]{40}\.json$/);
  expect(cacheFileName('c:\\S\\p\\p.VCXPROJ', 'Release', 'x64')).toBe(name);
  expect(cacheFileName('C:\\s\\P\\P.vcxproj', 'Debug', 'x64')).not.toBe(name);
});

function files(contents: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    read: async (p: string) => {
      reads.push(p);
      return p in contents ? Buffer.from(contents[p]) : undefined;
    },
    exists: async (p: string) => p in contents,
  };
}

async function entryFor(contents: Record<string, string>, awaited: string[] = []): Promise<CacheEntry> {
  const f = files(contents);
  const hasher = new Hasher(f.read);
  const inputs = await Promise.all(Object.keys(contents).map(async p => ({ path: p, sha1: (await hasher.sha1(p))! })));
  return { key: cacheKey(base), dump: { records: [], systemIncludes: [] }, inputs, awaited };
}

test('fresh while nothing changed; stale by content, by a missing input, by an awaited file, by the key', async () => {
  const start = { 'C:\\s\\P\\P.vcxproj': '<Project/>', 'C:\\s\\Common.props': 'v1' };
  const entry = await entryFor(start, ['C:\\s\\Directory.Build.props']);
  const fresh = (contents: Record<string, string>, key = cacheKey(base)) => {
    const f = files(contents);
    return isFresh(entry, key, new Hasher(f.read), f.exists);
  };
  expect(await fresh(start)).toBe(true);
  expect(await fresh({ ...start, 'C:\\s\\Common.props': 'v2' })).toBe(false);
  expect(await fresh({ 'C:\\s\\P\\P.vcxproj': '<Project/>' })).toBe(false);
  expect(await fresh({ ...start, 'C:\\s\\Directory.Build.props': '' })).toBe(false);
  expect(await fresh(start, cacheKey({ ...base, configuration: 'Debug' }))).toBe(false);
});

test('a shared file is read once per hasher', async () => {
  const f = files({ 'C:\\shared.props': 'x' });
  const hasher = new Hasher(f.read);
  const [a, b] = await Promise.all([hasher.sha1('C:\\shared.props'), hasher.sha1('c:\\SHARED.props')]);
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{40}$/);
  expect(f.reads).toHaveLength(1);
  expect(await hasher.sha1('C:\\missing.props')).toBeUndefined();
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vssln-cache-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the store writes atomically, reads back, removes, and treats a corrupt file as a miss', async () => {
  const store = fileCacheStore(path.join(dir, 'intellisense'));
  const entry = await entryFor({ 'C:\\a': 'x' });
  expect(await store.read('a.json')).toBeUndefined();
  await store.write('a.json', entry);
  expect(await store.read('a.json')).toEqual(entry);
  expect(fs.readdirSync(path.join(dir, 'intellisense'))).toEqual(['a.json']);
  fs.writeFileSync(path.join(dir, 'intellisense', 'b.json'), '{"key": 1');
  expect(await store.read('b.json')).toBeUndefined();
  fs.writeFileSync(path.join(dir, 'intellisense', 'c.json'), '{"key": "k"}');
  expect(await store.read('c.json')).toBeUndefined();
  await store.remove('a.json');
  await store.remove('a.json');
  expect(await store.read('a.json')).toBeUndefined();
});
