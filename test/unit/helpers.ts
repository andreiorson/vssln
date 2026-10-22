import * as fs from 'fs';
import * as path from 'path';
import { scanVcxproj, VcxprojScan } from '../../src/solution/projectScan';
import { parseSln } from '../../src/solution/slnParser';

export const fixturesDir = path.join(__dirname, '..', 'fixtures');

export function fixturePath(rel: string): string {
  return path.join(fixturesDir, ...rel.split('/'));
}

export function readFixture(rel: string): string {
  return fs.readFileSync(fixturePath(rel), 'utf8');
}

/** The fixture solution parsed from its real location, with static scans of its C++ projects keyed by guid. */
export function loadSample() {
  const sample = parseSln(readFixture('workspace/Sample.sln'), fixturePath('workspace/Sample.sln'));
  const scans = new Map<string, VcxprojScan | undefined>();
  for (const p of sample.projects.filter(p => p.kind === 'vcxproj')) {
    scans.set(p.guid, fs.existsSync(p.absPath) ? scanVcxproj(fs.readFileSync(p.absPath, 'utf8')) : undefined);
  }
  return { sample, scans };
}

/** In-memory text files keyed by absolute path, shaped like the injected fs of the settings modules. */
export function memoryFs(files: Record<string, string>) {
  return {
    files,
    async readText(p: string): Promise<string | undefined> {
      return files[p];
    },
    async writeText(p: string, text: string): Promise<void> {
      files[p] = text;
    },
  };
}
