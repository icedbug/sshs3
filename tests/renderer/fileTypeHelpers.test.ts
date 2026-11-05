import { describe, it, expect } from 'vitest';
import {
  getFileExtension,
  isMarkdownFile,
  isHtmlFile,
  isRasterImageFile,
  isSvgFile,
  isPdfFile,
  isCsvFile,
  isJsonFile,
  isDualModeFile,
  getPreviewLabel,
  isDirectPreviewFile,
} from '../../src/renderer/src/components/FileManager/fileTypeHelpers';

describe('fileTypeHelpers', () => {
  it('extracts file extensions correctly', () => {
    expect(getFileExtension('readme.md')).toBe('md');
    expect(getFileExtension('photo.PNG')).toBe('png');
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
    expect(getFileExtension('noextension')).toBe('');
    expect(getFileExtension('.gitignore')).toBe('gitignore');
  });

  it('detects markdown files', () => {
    expect(isMarkdownFile('README.md')).toBe(true);
    expect(isMarkdownFile('guide.markdown')).toBe(true);
    expect(isMarkdownFile('docs.mdx')).toBe(true);
    expect(isMarkdownFile('index.html')).toBe(false);
  });

  it('detects html files', () => {
    expect(isHtmlFile('index.html')).toBe(true);
    expect(isHtmlFile('about.htm')).toBe(true);
    expect(isHtmlFile('style.css')).toBe(false);
  });

  it('detects raster image files', () => {
    expect(isRasterImageFile('avatar.png')).toBe(true);
    expect(isRasterImageFile('photo.JPG')).toBe(true);
    expect(isRasterImageFile('banner.jpeg')).toBe(true);
    expect(isRasterImageFile('icon.webp')).toBe(true);
    expect(isRasterImageFile('anim.gif')).toBe(true);
    expect(isRasterImageFile('favicon.ico')).toBe(true);
    expect(isRasterImageFile('diagram.svg')).toBe(false);
  });

  it('detects svg files', () => {
    expect(isSvgFile('logo.svg')).toBe(true);
    expect(isSvgFile('logo.svg.txt')).toBe(false);
  });

  it('detects pdf files', () => {
    expect(isPdfFile('manual.pdf')).toBe(true);
    expect(isPdfFile('manual.doc')).toBe(false);
  });

  it('detects csv and tsv files', () => {
    expect(isCsvFile('data.csv')).toBe(true);
    expect(isCsvFile('data.tsv')).toBe(true);
    expect(isCsvFile('data.txt')).toBe(false);
  });

  it('detects json files', () => {
    expect(isJsonFile('package.json')).toBe(true);
    expect(isJsonFile('tsconfig.JSON')).toBe(true);
    expect(isJsonFile('data.xml')).toBe(false);
  });

  it('identifies dual mode files', () => {
    expect(isDualModeFile('readme.md')).toBe(true);
    expect(isDualModeFile('index.html')).toBe(true);
    expect(isDualModeFile('vector.svg')).toBe(true);
    expect(isDualModeFile('table.csv')).toBe(true);
    expect(isDualModeFile('data.tsv')).toBe(true);
    expect(isDualModeFile('script.js')).toBe(false);
  });

  it('returns appropriate preview labels', () => {
    expect(getPreviewLabel('table.csv')).toBe('Table');
    expect(getPreviewLabel('data.tsv')).toBe('Table');
    expect(getPreviewLabel('index.html')).toBe('Preview');
    expect(getPreviewLabel('readme.md')).toBe('Preview');
  });

  it('identifies direct preview files', () => {
    expect(isDirectPreviewFile('photo.png')).toBe(true);
    expect(isDirectPreviewFile('document.pdf')).toBe(true);
    expect(isDirectPreviewFile('vector.svg')).toBe(false);
    expect(isDirectPreviewFile('index.html')).toBe(false);
  });
});
