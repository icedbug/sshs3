import React, { useState, useRef, useMemo, useEffect } from 'react';
import { ZoomIn, ZoomOut, Maximize, RotateCcw, AlertCircle } from 'lucide-react';
import { classNames, formatBytes } from '../../lib/format';

export interface ImageViewerProps {
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  base64?: string;
  svgContent?: string;
  onDimensionsChange?: (dimensions: { width: number; height: number } | null) => void;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({
  fileName,
  fileSize,
  mimeType = 'image/png',
  base64,
  svgContent,
  onDimensionsChange,
}) => {
  const [scale, setScale] = useState<number>(1);
  const [fitMode, setFitMode] = useState<boolean>(true);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [hasError, setHasError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build the image source URL
  const imageSrc = useMemo(() => {
    if (svgContent) {
      return `data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}`;
    }
    if (base64) {
      return `data:${mimeType};base64,${base64}`;
    }
    return '';
  }, [base64, svgContent, mimeType]);

  useEffect(() => {
    setHasError(false);
    setNaturalSize(null);
  }, [imageSrc, fileName]);

  const handleImageLoaded = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const dims = { width: img.naturalWidth, height: img.naturalHeight };
    setNaturalSize(dims);
    onDimensionsChange?.(dims);
  };

  const handleZoomIn = () => {
    setFitMode(false);
    setScale((prev) => Math.min(prev * 1.25, 8));
  };

  const handleZoomOut = () => {
    setFitMode(false);
    setScale((prev) => Math.max(prev / 1.25, 0.1));
  };

  const handleFit = () => {
    setFitMode(true);
    setScale(1);
  };

  const handleActualSize = () => {
    setFitMode(false);
    setScale(1);
  };

  return (
    <div
      ref={containerRef}
      data-testid="image-viewer"
      className="relative flex flex-col h-full w-full overflow-hidden select-none bg-app-card"
    >
      {/* Floating Toolbar */}
      <div className="absolute top-3 right-4 z-20 flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface/90 backdrop-blur-md px-2 py-1 shadow-md text-xs text-txt-secondary">
        <button
          aria-label="Zoom In (+)"
          type="button"
          title="Zoom In (+)"
          onClick={handleZoomIn}
          className="rounded p-1 hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          aria-label="Zoom Out (-)"
          type="button"
          title="Zoom Out (-)"
          onClick={handleZoomOut}
          className="rounded p-1 hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          aria-label="Fit to Screen"
          type="button"
          title="Fit to Screen"
          onClick={handleFit}
          className={classNames(
            'rounded p-1 transition-colors',
            fitMode
              ? 'bg-sky-500/20 text-sky-400'
              : 'hover:bg-app-surface-hover hover:text-txt-primary'
          )}
        >
          <Maximize className="h-4 w-4" />
        </button>
        <button
          aria-label="Actual Size (100%)"
          type="button"
          title="Actual Size (100%)"
          onClick={handleActualSize}
          className={classNames(
            'rounded px-1.5 py-0.5 text-2xs font-semibold font-mono transition-colors',
            !fitMode && scale === 1
              ? 'bg-sky-500/20 text-sky-400'
              : 'hover:bg-app-surface-hover hover:text-txt-primary'
          )}
        >
          1:1
        </button>
        <button
          aria-label="Reset View"
          type="button"
          title="Reset View"
          onClick={handleFit}
          className="rounded p-1 hover:bg-app-surface-hover hover:text-txt-primary transition-colors ml-0.5"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Main Viewport with transparency checkerboard pattern */}
      <div
        className="flex-1 w-full h-full overflow-auto flex items-center justify-center p-6 relative"
        style={{
          backgroundImage: `
            linear-gradient(45deg, rgba(255, 255, 255, 0.04) 25%, transparent 25%),
            linear-gradient(-45deg, rgba(255, 255, 255, 0.04) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, rgba(255, 255, 255, 0.04) 75%),
            linear-gradient(-45deg, transparent 75%, rgba(255, 255, 255, 0.04) 75%)
          `,
          backgroundSize: '24px 24px',
          backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0px',
        }}
      >
        {hasError || !imageSrc ? (
          <div className="flex flex-col items-center gap-2 text-txt-muted text-sm">
            <AlertCircle className="h-8 w-8 text-amber-400/80" />
            <span>Unable to preview image data for {fileName}</span>
          </div>
        ) : (
          <img
            src={imageSrc}
            alt={fileName}
            onLoad={handleImageLoaded}
            onError={() => setHasError(true)}
            style={{
              transform: fitMode ? undefined : `scale(${scale})`,
              transformOrigin: 'center center',
              maxWidth: fitMode ? '100%' : undefined,
              maxHeight: fitMode ? '100%' : undefined,
              objectFit: 'contain',
              boxShadow: '0 10px 30px -5px rgba(0, 0, 0, 0.5)',
              borderRadius: '4px',
            }}
            className="transition-transform duration-100 ease-out cursor-zoom-in"
            onClick={() => {
              if (fitMode) {
                setFitMode(false);
                setScale(1.5);
              } else {
                handleFit();
              }
            }}
          />
        )}
      </div>

      {/* Footer bar with dimensions */}
      <div className="flex items-center justify-between border-t border-divider bg-app-surface px-4 py-1.5 text-xs text-txt-muted font-mono select-none">
        <div className="flex items-center gap-3">
          {naturalSize ? (
            <span>
              {naturalSize.width} × {naturalSize.height} px
            </span>
          ) : (
            <span>Loading dimensions...</span>
          )}
          {typeof fileSize === 'number' && fileSize > 0 && (
            <span>{formatBytes(fileSize)}</span>
          )}
          <span className="uppercase text-2xs">{mimeType.split('/').pop()}</span>
        </div>
        <div className="flex items-center gap-2">
          <span>{fitMode ? 'Fit' : `${Math.round(scale * 100)}%`}</span>
        </div>
      </div>
    </div>
  );
};

export default ImageViewer;
