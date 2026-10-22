import * as path from 'path';
import { applySelectionEdit, ParsedSettings, parseSettings, SelectionKey } from './settings';

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
}
