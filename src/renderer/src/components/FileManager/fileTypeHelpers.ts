import {
  CSV_EXTENSIONS,
  HTML_EXTENSIONS,
  JSON_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  PDF_EXTENSIONS,
  RASTER_IMAGE_EXTENSIONS,
  SVG_EXTENSIONS,
} from '../../lib/fileExtensions';

export function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx === -1) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTENSIONS.has(getFileExtension(name));
}

export function isHtmlFile(name: string): boolean {
  return HTML_EXTENSIONS.has(getFileExtension(name));
}

export function isRasterImageFile(name: string): boolean {
  return RASTER_IMAGE_EXTENSIONS.has(getFileExtension(name));
}

export function isSvgFile(name: string): boolean {
  return SVG_EXTENSIONS.has(getFileExtension(name));
}

export function isPdfFile(name: string): boolean {
  return PDF_EXTENSIONS.has(getFileExtension(name));
}

export function isCsvFile(name: string): boolean {
  return CSV_EXTENSIONS.has(getFileExtension(name));
}

export function isJsonFile(name: string): boolean {
  return JSON_EXTENSIONS.has(getFileExtension(name));
}

export function isDualModeFile(name: string): boolean {
  const ext = getFileExtension(name);
  return MARKDOWN_EXTENSIONS.has(ext) || HTML_EXTENSIONS.has(ext) || SVG_EXTENSIONS.has(ext) || CSV_EXTENSIONS.has(ext);
}

export function getPreviewLabel(name: string): 'Preview' | 'Table' {
  return isCsvFile(name) ? 'Table' : 'Preview';
}

export function isDirectPreviewFile(name: string): boolean {
  const ext = getFileExtension(name);
  return RASTER_IMAGE_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext);
}
