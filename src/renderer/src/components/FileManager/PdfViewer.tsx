import React, { useState, useEffect } from 'react';
import { FileText, ExternalLink, AlertCircle } from 'lucide-react';

export interface PdfViewerProps {
  fileName: string;
  base64?: string;
  onOpenExternal?: () => void;
}

export const PdfViewer: React.FC<PdfViewerProps> = ({ fileName, base64, onOpenExternal }) => {
  const [blobUrl, setBlobUrl] = useState<string>('');

  useEffect(() => {
    if (!base64) {
      setBlobUrl('');
      return undefined;
    }

    try {
      const binaryString = atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      setBlobUrl(url);

      return () => {
        URL.revokeObjectURL(url);
      };
    } catch (e) {
      console.error('Failed to create Blob from PDF base64:', e);
      setBlobUrl('');
      return undefined;
    }
  }, [base64]);

  return (
    <div
      data-testid="pdf-viewer"
      className="relative flex flex-col h-full w-full overflow-hidden select-none bg-app-card"
    >
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-2 text-xs select-none">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-rose-400" />
          <span className="font-semibold text-txt-primary">{fileName}</span>
          <span className="rounded bg-rose-500/20 text-rose-400 px-1.5 py-0.5 text-2xs font-mono font-medium">
            PDF Document
          </span>
        </div>

        {onOpenExternal && (
          <button
            type="button"
            title="Open in System Default PDF Viewer"
            onClick={onOpenExternal}
            className="flex items-center gap-1.5 rounded-lg border border-divider bg-app-surface px-2.5 py-1 text-xs font-semibold text-txt-secondary hover:border-sky-500/40 hover:text-sky-300 hover:bg-app-surface-hover transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5 text-sky-400" />
            <span>Open Externally</span>
          </button>
        )}
      </div>

      {/* Embedded PDF Viewport */}
      <div className="flex-1 w-full h-full overflow-hidden bg-slate-900">
        {blobUrl ? (
          <iframe
            src={`${blobUrl}#toolbar=1&navpanes=1`}
            className="w-full h-full border-none block"
            title={`PDF viewer for ${fileName}`}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-txt-muted text-sm">
            <AlertCircle className="h-8 w-8 text-amber-400" />
            <span>No PDF binary data available for {fileName}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default PdfViewer;
