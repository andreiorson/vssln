import * as path from 'path';
import { applySelectionEdit, ParsedSettings, parseSettings, removeKeys, SelectionKey } from './settings';

export interface SettingsFs {
  readText(p: string): Promise<string | undefined>;
  writeText(p: string, text: string): Promise<void>;
}

export const SETTINGS_RELATIVE_PATH = '.vscode/vssln.json';

export class SettingsSyntaxError extends Error {}

/** The personal settings file of one workspace folder. */
export class SettingsFile {
  readonly path: string;

  constructor(folder: string, private readonly fs: SettingsFs) {
    this.path = path.win32.join(folder, '.vscode', 'vssln.json');
  }

  async read(): Promise<ParsedSettings & { exists: boolean }> {
    const text = await this.fs.readText(this.path);
    return { ...parseSettings(text ?? ''), exists: text !== undefined };
  }

  /** Writes one selection key. Never touches a file that does not parse, so hand-written content is not lost. */
  async writeSelection(key: SelectionKey, value: string): Promise<{ created: boolean }> {
    const text = await this.fs.readText(this.path);
    if (text !== undefined && !parseSettings(text).syntaxOk) {
      throw new SettingsSyntaxError(`${this.path} has a syntax error.`);
    }
    await this.fs.writeText(this.path, applySelectionEdit(text ?? '', key, value));
    return { created: text === undefined };
  }

  /** Changes the file only when it exists, parses, and the change alters it. */
  async editIfValid(change: (text: string) => string): Promise<void> {
    const text = await this.fs.readText(this.path);
    if (text === undefined || !parseSettings(text).syntaxOk) return;
    const next = change(text);
    if (next !== text) await this.fs.writeText(this.path, next);
  }
}

/**
 * Selects a solution in `folder`: writes it there and drops that folder's configuration and startup project
 * (they belong to the previous solution); clears "solution" in every other folder so the choice wins on reload.
 */
export async function writeSolutionSelection(folders: string[], folder: string, relPath: string, fs: SettingsFs): Promise<{ created: boolean }> {
  const target = new SettingsFile(folder, fs);
  const result = await target.writeSelection('solution', relPath);
  await target.editIfValid(text => removeKeys(text, ['configuration', 'startupProject']));
  for (const other of folders) {
    if (other.toLowerCase() === folder.toLowerCase()) continue;
    await new SettingsFile(other, fs).editIfValid(text => removeKeys(text, ['solution']));
  }
  return result;
}
