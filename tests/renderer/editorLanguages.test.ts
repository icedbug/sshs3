import { describe, it, expect } from 'vitest';
import { getLanguageExtension } from '../../src/renderer/src/components/Editor/editorLanguages';

describe('editorLanguages', () => {
  it('returns valid extensions for known formats', () => {
    expect(getLanguageExtension('config.json')).not.toBeNull();
    expect(getLanguageExtension('manifest.yaml')).not.toBeNull();
    expect(getLanguageExtension('script.py')).not.toBeNull();
    expect(getLanguageExtension('index.ts')).not.toBeNull();
    expect(getLanguageExtension('component.tsx')).not.toBeNull();
    expect(getLanguageExtension('notes.md')).not.toBeNull();
    expect(getLanguageExtension('deploy.sh')).not.toBeNull();
    expect(getLanguageExtension('Dockerfile')).not.toBeNull();
    expect(getLanguageExtension('nginx.conf')).not.toBeNull();
    expect(getLanguageExtension('index.html')).not.toBeNull();
    expect(getLanguageExtension('todo.html')).not.toBeNull();
    expect(getLanguageExtension('style.css')).not.toBeNull();
    expect(getLanguageExtension('main.rs')).not.toBeNull();
    expect(getLanguageExtension('main.go')).not.toBeNull();
    expect(getLanguageExtension('main.cpp')).not.toBeNull();
  });

  it('returns null for unknown extensions or empty names', () => {
    expect(getLanguageExtension('')).toBeNull();
    expect(getLanguageExtension('archive.bin')).toBeNull();
    expect(getLanguageExtension('data.unknown')).toBeNull();
  });
});
