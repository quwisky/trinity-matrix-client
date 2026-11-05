import { describe, expect, it } from 'vitest';
import {
  CODE_LANGUAGES,
  languageById,
  resolveLanguage,
} from './code-languages';

describe('code languages', () => {
  it('resolves every fence name the current spec covers', () => {
    for (const name of [
      'bash',
      'c',
      'csharp',
      'css',
      'dart',
      'diff',
      'dockerfile',
      'go',
      'html',
      'ini',
      'java',
      'javascript',
      'json',
      'kotlin',
      'lua',
      'makefile',
      'markdown',
      'perl',
      'php',
      'powershell',
      'python',
      'ruby',
      'rust',
      'scala',
      'shellsession',
      'sql',
      'swift',
      'toml',
      'typescript',
      'xml',
      'yaml',
      'js',
      'ts',
      'py',
      'yml',
      'sh',
    ]) {
      expect(resolveLanguage(name), name).not.toBeNull();
    }
  });

  it('maps names to highlight.js ids', () => {
    expect(resolveLanguage('shellsession')?.id).toBe('shell');
    expect(resolveLanguage('toml')?.id).toBe('ini');
    expect(resolveLanguage('html')?.id).toBe('xml');
    expect(resolveLanguage('shell')?.id).toBe('bash');
  });

  it('ignores case', () => {
    expect(resolveLanguage('Python')?.id).toBe('python');
    expect(resolveLanguage('JSON')?.id).toBe('json');
  });

  it('returns null for an unknown fence', () => {
    expect(resolveLanguage('nosuchlang')).toBeNull();
  });

  it('loads a grammar function for every id', async () => {
    const entries = new Set(CODE_LANGUAGES.values());
    for (const entry of entries) {
      expect(typeof (await entry.load()).default, entry.id).toBe('function');
    }
  });

  it('shares one loader per id', () => {
    const loaders = new Map<string, unknown>();
    for (const entry of CODE_LANGUAGES.values()) {
      const seen = loaders.get(entry.id);
      if (seen) {
        expect(entry.load, entry.id).toBe(seen);
      }
      loaders.set(entry.id, entry.load);
    }
  });

  it('finds a grammar by its highlight.js id, which can differ from the fence name', () => {
    expect(languageById('shell')?.id).toBe('shell');
    expect(resolveLanguage('shell')?.id).toBe('bash');
    expect(languageById('ini')?.id).toBe('ini');
    expect(languageById('toml')).toBeNull();
  });
});
