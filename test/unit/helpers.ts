import * as fs from 'fs';
import * as path from 'path';

export const fixturesDir = path.join(__dirname, '..', 'fixtures');

export function fixturePath(rel: string): string {
  return path.join(fixturesDir, ...rel.split('/'));
}

export function readFixture(rel: string): string {
  return fs.readFileSync(fixturePath(rel), 'utf8');
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
