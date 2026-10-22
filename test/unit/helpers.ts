import * as fs from 'fs';
import * as path from 'path';

export const fixturesDir = path.join(__dirname, '..', 'fixtures');

export function fixturePath(rel: string): string {
  return path.join(fixturesDir, ...rel.split('/'));
}

export function readFixture(rel: string): string {
  return fs.readFileSync(fixturePath(rel), 'utf8');
}
