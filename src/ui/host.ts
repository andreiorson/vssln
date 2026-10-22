import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SettingsFs } from '../settings/settingsFile';
import { LoaderDeps } from '../state/loader';
import { Exec, findToolchain, ToolchainOptions, ToolchainResult } from '../toolchain/vswhere';
import { isSolutionCandidate } from '../util/paths';

/** Real implementations of the injected dependencies. */

export const exec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    // A hung vswhere (for example during a Visual Studio update) must not keep the panel loading forever.
    execFile(file, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
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

export function findRealToolchain(opts: ToolchainOptions): Promise<ToolchainResult> {
  return findToolchain(opts, { exec, exists, programFilesX86: process.env['ProgramFiles(x86)'] });
}

export function loaderDeps(toolchain: (opts: ToolchainOptions) => Promise<ToolchainResult>): LoaderDeps {
  return {
    folders: workspaceFolders(),
    env: process.env,
    async findSolutions() {
      // No explicit exclude: an explicit one would replace the user's files.exclude.
      const uris = await vscode.workspace.findFiles('**/*.sln');
      return uris.filter(u => u.scheme === 'file').map(u => u.fsPath).filter(isSolutionCandidate);
    },
    readText,
    exists,
    findToolchain: toolchain,
  };
}
