import { VsslnSettings } from '../settings/settings';
import { VcxprojScan } from '../solution/projectScan';
import { ParsedSolution, SolutionConfig } from '../solution/slnParser';
import { VsInstance } from '../toolchain/vswhere';

export interface Problem {
  severity: 'error' | 'warning';
  message: string;
  action?: 'configureToolchain' | 'openSettings' | 'selectSolution';
}

export interface ProjectEntry {
  exists: boolean;
  scan?: VcxprojScan;
}

export interface AppState {
  phase: 'loading' | 'noSolution' | 'ready';
  /** Workspace folder whose vssln.json applies. */
  folder?: string;
  /** All discovered .sln files, absolute. */
  solutions: string[];
  solution?: ParsedSolution;
  configuration?: SolutionConfig;
  startupProjectGuid?: string;
  /** C++ projects only, by project guid. */
  projects: Map<string, ProjectEntry>;
  toolchain?: VsInstance;
  settings: VsslnSettings;
  settingsSyntaxOk: boolean;
  problems: Problem[];
}

export const initialState: AppState = {
  phase: 'loading',
  solutions: [],
  projects: new Map(),
  settings: {},
  settingsSyntaxOk: true,
  problems: [],
};

export class Store {
  private current: AppState = initialState;
  private readonly listeners = new Set<(s: AppState) => void>();

  get state(): AppState {
    return this.current;
  }

  set(next: AppState): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  onDidChange(listener: (s: AppState) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}
