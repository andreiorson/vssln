import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SettingsFs } from '../settings/settingsFile';
import { LoaderDeps } from '../state/loader';
import { Exec, findToolchain } from '../toolchain/vswhere';

/** Real implementations of the injected dependencies. */

export const exec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
  });

async function readText(p: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export const nodeFs: SettingsFs = {
  readText,
  async writeText(p, text) {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, text, 'utf8');
  },
};

export function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
}

export function loaderDeps(): LoaderDeps {
  return {
    folders: workspaceFolders(),
    async findSolutions() {
      const uris = await vscode.workspace.findFiles('**/*.sln', '**/{node_modules,.git,.vs}/**');
      return uris.filter(u => u.scheme === 'file').map(u => u.fsPath);
    },
    readText,
    exists,
    findToolchain: opts => findToolchain(opts, { exec, exists, programFilesX86: process.env['ProgramFiles(x86)'] }),
  };
}
