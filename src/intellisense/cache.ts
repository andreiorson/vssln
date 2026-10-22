import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathKey } from '../util/paths';
import { ProjectDump } from './dump';

/** Everything besides the input files that decides a project's IntelliSense result. */
export interface CacheKey {
  msbuildPath: string;
  projectPath: string;
  configuration: string;
  platform: string;
  solutionPath: string;
  /** msbuild.properties of vssln.json. */
  properties: Record<string, string>;
  /** environment of vssln.json, as expanded for MSBuild. */
  environment: Record<string, string>;
  targetsVersion: number;
}

export interface CacheEntry {
  key: string;
  dump: ProjectDump;
  /** The files the evaluation read, with their SHA-1 content hashes. */
  inputs: { path: string; sha1: string }[];
  /** Imports skipped because their file did not exist: creating one makes the entry stale. */
  awaited: string[];
}

function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function sorted(record: Record<string, string>): [string, string][] {
  return Object.keys(record).sort().map(k => [k, record[k]]);
}

export function cacheKey(k: CacheKey): string {
  return sha1(JSON.stringify([k.msbuildPath, pathKey(k.projectPath), k.configuration, k.platform, pathKey(k.solutionPath), sorted(k.properties), sorted(k.environment), k.targetsVersion]));
}

export function cacheFileName(projectPath: string, configuration: string, platform: string): string {
  return `${sha1(`${pathKey(projectPath)}|${configuration}|${platform}`)}.json`;
}

/** Content hashes, each file read once per pass however many projects share it (the toolset's props and targets). */
export class Hasher {
  private readonly hashes = new Map<string, Promise<string | undefined>>();

  constructor(private readonly read: (p: string) => Promise<Buffer | undefined>) {}

  sha1(p: string): Promise<string | undefined> {
    const k = pathKey(p);
    let hash = this.hashes.get(k);
    if (!hash) {
      hash = this.read(p).then(data => (data ? sha1(data) : undefined));
      this.hashes.set(k, hash);
    }
    return hash;
  }
}

/** Fresh when the key matches, every input still has its hash and no awaited file appeared; timestamps never count. */
export async function isFresh(entry: CacheEntry, key: string, hasher: Hasher, exists: (p: string) => Promise<boolean>): Promise<boolean> {
  if (entry.key !== key) return false;
  const hashes = await Promise.all(entry.inputs.map(i => hasher.sha1(i.path)));
  if (hashes.some((h, i) => h !== entry.inputs[i].sha1)) return false;
  const appeared = await Promise.all(entry.awaited.map(exists));
  return !appeared.some(Boolean);
}

export interface CacheStore {
  read(name: string): Promise<CacheEntry | undefined>;
  write(name: string, entry: CacheEntry): Promise<void>;
  remove(name: string): Promise<void>;
}

function isEntry(v: unknown): v is CacheEntry {
  const e = v as CacheEntry;
  return (
    typeof e === 'object' && e !== null && typeof e.key === 'string' &&
    typeof e.dump === 'object' && e.dump !== null && Array.isArray(e.dump.records) && Array.isArray(e.dump.systemIncludes) &&
    Array.isArray(e.inputs) && Array.isArray(e.awaited)
  );
}

/** One JSON file per entry; a write goes to a temporary file first and is renamed, so readers never see half of it. */
export function fileCacheStore(dir: string): CacheStore {
  return {
    async read(name) {
      try {
        const value: unknown = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
        return isEntry(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async write(name, entry) {
      await fs.promises.mkdir(dir, { recursive: true });
      const target = path.join(dir, name);
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.promises.writeFile(temp, JSON.stringify(entry), 'utf8');
      await fs.promises.rename(temp, target);
    },
    async remove(name) {
      await fs.promises.rm(path.join(dir, name), { force: true });
    },
  };
}
