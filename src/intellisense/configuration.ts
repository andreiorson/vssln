import { splitCommandLine } from '../debug/commandLine';

/** What cpptools needs for one file (its SourceFileConfiguration, without the optional fields). */
export interface CppConfiguration {
  includePath: string[];
  defines: string[];
  forcedInclude: string[];
  standard: string;
  intelliSenseMode: string;
}

const CPP_STANDARDS: Record<string, string> = { 'c++14': 'c++14', 'c++17': 'c++17', 'c++20': 'c++20', 'c++latest': 'c++23' };
// cpptools has no "clatest"; c17 is the newest C standard every cpptools version knows.
const C_STANDARDS: Record<string, string> = { c11: 'c11', c17: 'c17', clatest: 'c17' };
const MODES: Record<string, string> = { win32: 'windows-msvc-x86', x86: 'windows-msvc-x86', arm64: 'windows-msvc-arm64', arm: 'windows-msvc-arm' };

function option(token: string): string | undefined {
  return token.startsWith('/') || token.startsWith('-') ? token.slice(1) : undefined;
}

/**
 * Maps an MSVC command line to a cpptools configuration: /I (then the system directories), /D and /U, /FI, the
 * language standard (/std, /TC, /TP or the file's extension) and the IntelliSense mode of the platform. Precompiled
 * header and output switches are not needed: cpptools reads the #include of the header itself.
 */
export function toConfiguration(commandLine: string, systemIncludes: string[], platform: string, file?: string): CppConfiguration {
  const tokens = splitCommandLine(commandLine);
  const includes: string[] = [];
  const defines: string[] = [];
  const forcedInclude: string[] = [];
  let cpp: string | undefined;
  let c: string | undefined;
  let language: 'c' | 'cpp' | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const opt = option(tokens[i]);
    if (opt === undefined) continue;
    // /I, /D, /U and /FI take their value attached or as the next token.
    const value = (name: string) => (opt.length > name.length ? opt.slice(name.length) : (tokens[++i] ?? ''));
    if (opt.startsWith('FI')) forcedInclude.push(value('FI'));
    else if (opt.startsWith('I')) includes.push(value('I'));
    else if (opt.startsWith('external:I')) includes.push(value('external:I'));
    else if (opt.startsWith('D')) defines.push(value('D').replace('#', '='));
    else if (opt.startsWith('U')) {
      const name = value('U');
      for (let j = defines.length - 1; j >= 0; j--) if (defines[j].split('=')[0] === name) defines.splice(j, 1);
    } else if (opt.startsWith('std:')) {
      const std = opt.slice(4).toLowerCase();
      if (CPP_STANDARDS[std]) cpp = CPP_STANDARDS[std];
      else if (C_STANDARDS[std]) c = C_STANDARDS[std];
    } else if (opt === 'TC') language = 'c';
    else if (opt === 'TP') language = 'cpp';
  }

  const isC = language === 'c' || (language === undefined && /\.c$/i.test(file ?? ''));
  const seen = new Set<string>();
  const includePath = [...includes, ...systemIncludes].filter(d => d !== '' && !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()));
  return {
    includePath,
    defines: defines.filter(Boolean),
    forcedInclude,
    standard: isC ? (c ?? 'c17') : (cpp ?? 'c++14'),
    intelliSenseMode: MODES[platform.toLowerCase()] ?? 'windows-msvc-x64',
  };
}
