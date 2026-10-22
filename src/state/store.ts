import { VsslnSettings } from '../settings/settings';
import { ProjectItems } from '../solution/projectItems';
import { VcxprojScan } from '../solution/projectScan';
import { ParsedSolution, SolutionConfig } from '../solution/slnParser';
import { VsInstance } from '../toolchain/vswhere';
import { BuildState, idleBuild } from './build';

export interface Problem {
  severity: 'error' | 'warning';
  message: string;
  action?: 'configureToolchain' | 'openSettings' | 'selectSolution' | 'showLog';
}

export interface ProjectEntry {
  exists: boolean;
  scan?: VcxprojScan;
  items?: ProjectItems;
}

export interface AppState {
  phase: 'loading' | 'noSolution' | 'ready' | 'failed';
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
  build: BuildState;
  intellisense: IntelliSenseState;
}

/** A project's IntelliSense data in the current pass. */
export interface ProjectIntelliSense {
  status: 'waiting' | 'computing' | 'ready' | 'failed';
  fromCache?: boolean;
  /** The tail of MSBuild's output when it failed. */
  message?: string;
  seconds?: number;
}

export interface IntelliSenseState {
  /** The C++ projects of the current pass, by guid. */
  projects: Map<string, ProjectIntelliSense>;
  running: boolean;
}

export const idleIntelliSense: IntelliSenseState = { projects: new Map(), running: false };

export const initialState: AppState = {
  phase: 'loading',
  solutions: [],
  projects: new Map(),
  settings: {},
  settingsSyntaxOk: true,
  problems: [],
  build: idleBuild,
  intellisense: idleIntelliSense,
};

/** State after loading threw: nothing to show except why, with a way to the log. */
export function failedState(message: string): AppState {
  return { ...initialState, projects: new Map(), phase: 'failed', problems: [{ severity: 'error', message, action: 'showLog' }] };
}

export class Store {
  private current: AppState = initialState;
  private readonly listeners = new Set<(s: AppState) => void>();

  get state(): AppState {
    return this.current;
  }

  update(change: (s: AppState) => AppState): void {
    this.set(change(this.current));
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
