import { execFile, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EnvExec, EVALUATION_TIMEOUT_S } from '../debug/properties';
import { RunChild } from '../debug/runAdapter';
import { SettingsFs } from '../settings/settingsFile';
import { LoaderDeps } from '../state/loader';
import { Exec, findToolchain, ToolchainOptions, ToolchainResult } from '../toolchain/vswhere';
import { isSolutionCandidate } from '../util/paths';
import { decodeText } from '../util/text';

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

/** execFile with an environment, for MSBuild evaluations (no shell). */
export const envExec: EnvExec = (file, args, env, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeout = opts.timeoutMs ?? EVALUATION_TIMEOUT_S * 1000;
    execFile(file, args, { env, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, signal: opts.signal }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
  });

/** Starts a program for a Run (no shell); `newConsole` gives it a console window of its own. */
export function spawnRun(program: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined>; newConsole: boolean }): RunChild {
  const child = opts.newConsole
    ? spawn(program, args, { cwd: opts.cwd, env: opts.env, shell: false, detached: true, stdio: 'ignore', windowsHide: false })
    : spawn(program, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, stdio: 'pipe' });
  let exited = false;
  let exitCb: (code: number | null) => void = () => {};
  let errorCb: (message: string) => void = () => {};
  child.on('error', e => {
    if (exited) return;
    exited = true;
    errorCb(e.message);
  });
  child.on('close', code => {
    if (exited) return;
    exited = true;
    exitCb(code);
  });
  return {
    pid: child.pid,
    onStdout: cb => child.stdout?.setEncoding('utf8').on('data', (t: string) => cb(t)),
    onStderr: cb => child.stderr?.setEncoding('utf8').on('data', (t: string) => cb(t)),
    onExit: cb => (exitCb = cb),
    onError: cb => (errorCb = cb),
  };
}

/** Ends a process with its children right away (Stop of a Run, extension shutdown). */
export function killTreeNow(pid: number): void {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return decodeText(await fs.promises.readFile(p));
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
