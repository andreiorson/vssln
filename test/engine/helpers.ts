import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VsslnApi } from '../../src/extension';

export async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met in ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

export async function api(): Promise<VsslnApi> {
  const a = await vscode.extensions.getExtension<VsslnApi>('local.vssln')!.activate();
  await waitFor(() => a.getState().phase === 'ready', 30000);
  return a;
}

/** Writes vssln.json; Windows briefly refuses to recreate a folder that was just deleted while being watched. */
export async function writeSettings(dir: string, text: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'vssln.json'), text);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 20) throw e;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

export function removeSettings(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export const guidOf = (a: VsslnApi, name: string) => a.getState().solution!.projects.find(p => p.name === name)!.guid;
