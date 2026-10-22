import { execFile, spawn } from 'child_process';

export interface ChildProcessLike {
  pid?: number;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export type Spawn = (file: string, args: string[], env: Record<string, string | undefined>) => ChildProcessLike;
export type KillTree = (pid: number) => Promise<void>;

/** Splits a stream of text chunks into lines (LF or CRLF); `end` flushes the last unterminated line. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let rest = '';
  return {
    push(chunk) {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) onLine(part.replace(/\r$/, ''));
    },
    end() {
      if (rest !== '') onLine(rest.replace(/\r$/, ''));
      rest = '';
    },
  };
}

/** Runs one MSBuild process at a time; Stop kills its whole process tree. */
export class BuildRunner {
  private current?: { pid?: number; cancelled: boolean };

  constructor(private readonly spawn: Spawn, private readonly kill: KillTree) {}

  get running(): boolean {
    return this.current !== undefined;
  }

  run(
    file: string,
    args: string[],
    env: Record<string, string | undefined>,
    onLine: (line: string) => void,
  ): Promise<{ exitCode: number | null; cancelled: boolean }> {
    if (this.current) return Promise.reject(new Error('A build is already running.'));
    return new Promise(resolve => {
      const proc = this.spawn(file, args, env);
      const current = { pid: proc.pid, cancelled: false };
      this.current = current;
      proc.onLine(onLine);
      proc.onExit(code => {
        if (this.current === current) this.current = undefined;
        resolve({ exitCode: code, cancelled: current.cancelled });
      });
    });
  }

  async stop(): Promise<void> {
    const current = this.current;
    if (!current || current.pid === undefined) return;
    current.cancelled = true;
    await this.kill(current.pid);
  }
}

/** child_process.spawn without a shell; stdout and stderr become one stream of UTF-8 lines. */
export function realSpawn(): Spawn {
  return (file, args, env) => {
    const child = spawn(file, args, { env, shell: false, windowsHide: true });
    let lineCb: (line: string) => void = () => {};
    const out = lineSplitter(l => lineCb(l));
    const err = lineSplitter(l => lineCb(l));
    child.stdout.setEncoding('utf8').on('data', (c: string) => out.push(c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => err.push(c));
    let exitCb: (code: number | null) => void = () => {};
    // A failed start (no MSBuild.exe) is reported as exit code null after a message line.
    child.on('error', e => {
      lineCb(`error: ${e.message}`);
      exitCb(null);
    });
    child.on('close', code => {
      out.end();
      err.end();
      exitCb(code);
    });
    return {
      pid: child.pid,
      onLine: cb => (lineCb = cb),
      onExit: cb => (exitCb = cb),
    };
  };
}

/** taskkill /t /f ends MSBuild together with its worker nodes and the compilers they started. */
export function realKillTree(): KillTree {
  return pid =>
    new Promise(resolve => {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve());
    });
}
