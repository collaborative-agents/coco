import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

type AnnotationTool = 'pen' | 'arrow' | 'rectangle' | 'text';
type EditPhase = 'select' | 'annotate';

interface Point {
  x: number;
  y: number;
}

interface Selection {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Annotation =
  | {
      tool: 'pen';
      points: Point[];
      color: string;
      width: number;
    }
  | {
      tool: 'arrow';
      start: Point;
      end: Point;
      color: string;
      width: number;
    }
  | {
      tool: 'rectangle';
      start: Point;
      end: Point;
      color: string;
      width: number;
    }
  | {
      tool: 'text';
      point: Point;
      text: string;
      color: string;
      width: number;
    };

interface PreviewPayload {
  imageDataUrl?: unknown;
  editable?: unknown;
  fullScreenOverlay?: unknown;
}

const ACCENT = '#204A79';
const ACCENT_BG = '#E9EFFF';
const ACCENT_BORDER = '#BCD0FC';
const COLORS = [
  '#ef4444',
  '#f59e0b',
  '#22c55e',
  '#38bdf8',
  '#a855f7',
  '#ffffff',
];
const TOOLS: Array<{ id: AnnotationTool; label: string }> = [
  { id: 'pen', label: 'Pen' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'text', label: 'Text' },
];

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'relative',
    display: 'flex',
    width: '100vw',
    height: '100vh',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    background: '#111827',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    userSelect: 'none',
  },
  backdrop: {
    position: 'absolute',
    inset: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'zoom-out',
  },
  image: {
    position: 'relative',
    zIndex: 1,
    display: 'block',
    maxWidth: 'calc(100vw - 48px)',
    maxHeight: 'calc(100vh - 48px)',
    objectFit: 'contain',
    borderRadius: 10,
    boxShadow: '0 16px 56px rgba(0, 0, 0, 0.55)',
  },
  canvas: {
    position: 'relative',
    zIndex: 1,
    display: 'block',
    maxWidth: 'calc(100vw - 48px)',
    maxHeight: 'calc(100vh - 48px)',
    borderRadius: 8,
    boxShadow: '0 16px 56px rgba(0, 0, 0, 0.55)',
    touchAction: 'none',
  },
  overlayCanvas: {
    width: '100vw',
    height: '100vh',
    maxWidth: 'none',
    maxHeight: 'none',
    borderRadius: 0,
    boxShadow: 'none',
  },
  toolbar: {
    position: 'fixed',
    zIndex: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    maxWidth: 'calc(100vw - 24px)',
    padding: 6,
    overflowX: 'auto',
    border: '1px solid rgba(148, 163, 184, 0.38)',
    borderRadius: 14,
    background: 'rgba(248, 250, 252, 0.94)',
    color: '#374151',
    boxShadow:
      '0 12px 32px rgba(15, 23, 42, 0.22), 0 2px 8px rgba(15, 23, 42, 0.12)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  },
  toolButton: {
    display: 'inline-flex',
    width: 34,
    height: 34,
    flex: '0 0 auto',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    border: '1px solid transparent',
    borderRadius: 8,
    background: 'transparent',
    color: '#4b5563',
    cursor: 'pointer',
  },
  toolButtonActive: {
    borderColor: ACCENT_BORDER,
    background: ACCENT_BG,
    color: ACCENT,
  },
  divider: {
    width: 1,
    height: 24,
    flex: '0 0 auto',
    margin: '0 2px',
    background: 'rgba(148, 163, 184, 0.35)',
  },
  colorButton: {
    width: 22,
    height: 22,
    flex: '0 0 auto',
    padding: 0,
    border: '2px solid rgba(255, 255, 255, 0.95)',
    borderRadius: '50%',
    cursor: 'pointer',
    boxShadow: '0 0 0 1px rgba(71, 85, 105, 0.34)',
  },
  colorButtonActive: {
    boxShadow: `0 0 0 2px ${ACCENT}`,
  },
  widthSelect: {
    height: 32,
    flex: '0 0 auto',
    padding: '0 6px',
    border: '1px solid rgba(148, 163, 184, 0.45)',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, 0.82)',
    color: '#374151',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 11,
  },
  actionButton: {
    display: 'inline-flex',
    height: 34,
    flex: '0 0 auto',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '0 9px',
    border: '1px solid rgba(148, 163, 184, 0.4)',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, 0.72)',
    color: '#475569',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 600,
  },
  saveButton: {
    borderColor: ACCENT,
    background: ACCENT,
    color: '#fff',
  },
  disabled: { opacity: 0.36, cursor: 'default' },
  selectionHint: {
    position: 'fixed',
    zIndex: 3,
    bottom: 22,
    left: '50%',
    padding: '7px 12px',
    transform: 'translateX(-50%)',
    border: '1px solid rgba(255, 255, 255, 0.36)',
    borderRadius: 999,
    background: 'rgba(30, 41, 59, 0.76)',
    color: '#fff',
    boxShadow: '0 5px 18px rgba(15, 23, 42, 0.22)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  close: {
    position: 'absolute',
    zIndex: 2,
    top: 20,
    right: 20,
    width: 38,
    height: 38,
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.5)',
    background: 'rgba(17, 24, 39, 0.8)',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 25,
    lineHeight: '34px',
    padding: 0,
  },
};

function closePreview() {
  window.electron?.ipcRenderer.sendMessage('close-image-preview');
}

function normalizeSelection(start: Point, end: Point): Selection {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

function selectionWidth(selection: Selection) {
  return selection.right - selection.left;
}

function selectionHeight(selection: Selection) {
  return selection.bottom - selection.top;
}

function clampPoint(point: Point, selection: Selection): Point {
  return {
    x: Math.min(selection.right, Math.max(selection.left, point.x)),
    y: Math.min(selection.bottom, Math.max(selection.top, point.y)),
  };
}

function pointInSelection(point: Point, selection: Selection) {
  return (
    point.x >= selection.left &&
    point.x <= selection.right &&
    point.y >= selection.top &&
    point.y <= selection.bottom
  );
}

function drawAnnotation(
  context: CanvasRenderingContext2D,
  annotation: Annotation,
) {
  context.save();
  context.strokeStyle = annotation.color;
  context.fillStyle = annotation.color;
  context.lineWidth = annotation.width;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  if (annotation.tool === 'pen') {
    const [first, ...rest] = annotation.points;
    if (!first) {
      context.restore();
      return;
    }
    context.beginPath();
    context.moveTo(first.x, first.y);
    rest.forEach((point) => context.lineTo(point.x, point.y));
    if (rest.length === 0) {
      context.lineTo(first.x + 0.01, first.y + 0.01);
    }
    context.stroke();
  } else if (annotation.tool === 'rectangle') {
    context.strokeRect(
      annotation.start.x,
      annotation.start.y,
      annotation.end.x - annotation.start.x,
      annotation.end.y - annotation.start.y,
    );
  } else if (annotation.tool === 'arrow') {
    const dx = annotation.end.x - annotation.start.x;
    const dy = annotation.end.y - annotation.start.y;
    const angle = Math.atan2(dy, dx);
    const headLength = Math.max(14, annotation.width * 4);
    context.beginPath();
    context.moveTo(annotation.start.x, annotation.start.y);
    context.lineTo(annotation.end.x, annotation.end.y);
    context.lineTo(
      annotation.end.x - headLength * Math.cos(angle - Math.PI / 6),
      annotation.end.y - headLength * Math.sin(angle - Math.PI / 6),
    );
    context.moveTo(annotation.end.x, annotation.end.y);
    context.lineTo(
      annotation.end.x - headLength * Math.cos(angle + Math.PI / 6),
      annotation.end.y - headLength * Math.sin(angle + Math.PI / 6),
    );
    context.stroke();
  } else {
    const fontSize = Math.max(20, annotation.width * 6);
    context.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    context.lineWidth = Math.max(2, annotation.width / 2);
    context.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    context.strokeText(annotation.text, annotation.point.x, annotation.point.y);
    context.fillText(annotation.text, annotation.point.x, annotation.point.y);
  }
  context.restore();
}

function drawSelectionOverlay(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  selection: Selection | null,
) {
  context.save();
  context.fillStyle = 'rgba(15, 23, 42, 0.42)';
  if (!selection) {
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
    return;
  }

  context.fillRect(0, 0, canvas.width, selection.top);
  context.fillRect(
    0,
    selection.bottom,
    canvas.width,
    canvas.height - selection.bottom,
  );
  context.fillRect(
    0,
    selection.top,
    selection.left,
    selectionHeight(selection),
  );
  context.fillRect(
    selection.right,
    selection.top,
    canvas.width - selection.right,
    selectionHeight(selection),
  );

  const scale = canvas.width / Math.max(1, window.innerWidth);
  context.strokeStyle = '#ffffff';
  context.lineWidth = Math.max(2, 1.5 * scale);
  context.strokeRect(
    selection.left,
    selection.top,
    selectionWidth(selection),
    selectionHeight(selection),
  );
  const handleSize = Math.max(5, 5 * scale);
  context.fillStyle = '#ffffff';
  [
    [selection.left, selection.top],
    [selection.right, selection.top],
    [selection.left, selection.bottom],
    [selection.right, selection.bottom],
  ].forEach(([x, y]) => {
    context.fillRect(
      x - handleSize / 2,
      y - handleSize / 2,
      handleSize,
      handleSize,
    );
  });
  context.restore();
}

function ToolGlyph({ tool }: { tool: AnnotationTool }) {
  if (tool === 'pen') {
    return (
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
      >
        <path
          d="M4 15.8l1-3.7L13.9 3.2a1.7 1.7 0 012.4 0l.5.5a1.7 1.7 0 010 2.4L7.9 15l-3.9.8z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M12.8 4.3l2.9 2.9" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (tool === 'arrow') {
    return (
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
      >
        <path
          d="M4 16L16 4M9.5 4H16v6.5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (tool === 'rectangle') {
    return (
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
      >
        <rect
          x="3.5"
          y="4.5"
          width="13"
          height="11"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.7"
        />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M4 4.5h12M10 4.5v11M7.2 15.5h5.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function ImagePreviewView() {
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [editable, setEditable] = useState(false);
  const [fullScreenOverlay, setFullScreenOverlay] = useState(false);
  const [phase, setPhase] = useState<EditPhase>('select');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<{
    start: Point;
    end: Point;
  } | null>(null);
  const [tool, setTool] = useState<AnnotationTool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [lineWidth, setLineWidth] = useState(5);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceImageRef = useRef<HTMLImageElement | null>(null);

  const activeSelection = selectionDraft
    ? normalizeSelection(selectionDraft.start, selectionDraft.end)
    : selection;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const source = sourceImageRef.current;
    if (!canvas || !source || !imageReady) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    annotations.forEach((annotation) => drawAnnotation(context, annotation));
    if (draft) drawAnnotation(context, draft);
    drawSelectionOverlay(context, canvas, activeSelection);
  }, [activeSelection, annotations, draft, imageReady]);

  useEffect(() => redraw(), [redraw]);

  useEffect(() => {
    if (!imageDataUrl || !editable) return undefined;
    setImageReady(false);
    const source = new Image();
    source.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = source.naturalWidth || source.width;
      canvas.height = source.naturalHeight || source.height;
      sourceImageRef.current = source;
      setImageReady(true);
    };
    source.src = imageDataUrl;
    return () => {
      source.onload = null;
    };
  }, [editable, imageDataUrl]);

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'image-preview',
      (payload: unknown) => {
        const preview = (payload ?? {}) as PreviewPayload;
        if (
          typeof preview.imageDataUrl === 'string' &&
          preview.imageDataUrl.startsWith('data:image/')
        ) {
          setImageDataUrl(preview.imageDataUrl);
          setEditable(preview.editable === true);
          setFullScreenOverlay(preview.fullScreenOverlay === true);
          setPhase('select');
          setSelection(null);
          setSelectionDraft(null);
          setAnnotations([]);
          setRedoStack([]);
          setDraft(null);
        }
      },
    );
    window.electron?.ipcRenderer.sendMessage('image-preview-ready');
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePreview();
      if (
        !editable ||
        phase !== 'annotate' ||
        !(event.metaKey || event.ctrlKey)
      ) {
        return;
      }
      if (event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      if (event.shiftKey) {
        setRedoStack((currentRedo) => {
          const restored = currentRedo[currentRedo.length - 1];
          if (!restored) return currentRedo;
          setAnnotations((current) => [...current, restored]);
          return currentRedo.slice(0, -1);
        });
      } else {
        setAnnotations((current) => {
          const removed = current[current.length - 1];
          if (!removed) return current;
          setRedoStack((currentRedo) => [...currentRedo, removed]);
          return current.slice(0, -1);
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editable, phase]);

  const pointFromEvent = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imageReady) return;
    const point = pointFromEvent(event);
    if (phase === 'select') {
      event.currentTarget.setPointerCapture(event.pointerId);
      setSelectionDraft({ start: point, end: point });
      return;
    }
    if (!selection || !pointInSelection(point, selection)) return;
    if (tool === 'text') {
      // A native prompt keeps text entry focused above the full-screen canvas.
      // eslint-disable-next-line no-alert
      const text = window.prompt('Text to add to the screenshot:')?.trim();
      if (text) {
        setAnnotations((current) => [
          ...current,
          { tool: 'text', point, text, color, width: lineWidth },
        ]);
        setRedoStack([]);
      }
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === 'pen') {
      setDraft({ tool, points: [point], color, width: lineWidth });
    } else {
      setDraft({ tool, start: point, end: point, color, width: lineWidth });
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointFromEvent(event);
    if (phase === 'select') {
      setSelectionDraft((current) =>
        current ? { ...current, end: point } : current,
      );
      return;
    }
    if (!draft || !selection) return;
    const boundedPoint = clampPoint(point, selection);
    setDraft((current) => {
      if (!current) return null;
      if (current.tool === 'pen') {
        return { ...current, points: [...current.points, boundedPoint] };
      }
      if (current.tool === 'text') return current;
      return { ...current, end: boundedPoint };
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (phase === 'select') {
      if (!selectionDraft) return;
      const nextSelection = normalizeSelection(
        selectionDraft.start,
        selectionDraft.end,
      );
      setSelectionDraft(null);
      if (
        selectionWidth(nextSelection) >= 12 &&
        selectionHeight(nextSelection) >= 12
      ) {
        setSelection(nextSelection);
        setPhase('annotate');
      }
      return;
    }
    if (!draft) return;
    setAnnotations((current) => [...current, draft]);
    setRedoStack([]);
    setDraft(null);
  };

  const undo = () => {
    setAnnotations((current) => {
      const removed = current[current.length - 1];
      if (!removed) return current;
      setRedoStack((currentRedo) => [...currentRedo, removed]);
      return current.slice(0, -1);
    });
  };

  const redo = () => {
    setRedoStack((currentRedo) => {
      const restored = currentRedo[currentRedo.length - 1];
      if (!restored) return currentRedo;
      setAnnotations((current) => [...current, restored]);
      return currentRedo.slice(0, -1);
    });
  };

  const reselect = () => {
    setPhase('select');
    setSelection(null);
    setSelectionDraft(null);
    setAnnotations([]);
    setRedoStack([]);
    setDraft(null);
  };

  const saveAnnotation = () => {
    const source = sourceImageRef.current;
    if (!source || !selection || !imageReady) return;
    const width = Math.max(1, Math.round(selectionWidth(selection)));
    const height = Math.max(1, Math.round(selectionHeight(selection)));
    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d');
    if (!context) return;
    context.drawImage(
      source,
      selection.left,
      selection.top,
      selectionWidth(selection),
      selectionHeight(selection),
      0,
      0,
      width,
      height,
    );
    context.save();
    context.translate(-selection.left, -selection.top);
    annotations.forEach((annotation) => drawAnnotation(context, annotation));
    context.restore();
    window.electron?.ipcRenderer.sendMessage('save-image-annotation', {
      imageDataUrl: output.toDataURL('image/png'),
    });
  };

  const toolbarPosition = (): CSSProperties => {
    const canvas = canvasRef.current;
    if (!canvas || !selection) {
      return { left: '50%', bottom: 18, transform: 'translateX(-50%)' };
    }
    const bounds = canvas.getBoundingClientRect();
    const scaleX = bounds.width / canvas.width;
    const scaleY = bounds.height / canvas.height;
    const center =
      bounds.left + ((selection.left + selection.right) / 2) * scaleX;
    const selectionTop = bounds.top + selection.top * scaleY;
    const selectionBottom = bounds.top + selection.bottom * scaleY;
    const clampedCenter = Math.min(
      window.innerWidth - 290,
      Math.max(290, center),
    );
    if (selectionBottom + 62 < window.innerHeight) {
      return {
        left: clampedCenter,
        top: selectionBottom + 10,
        transform: 'translateX(-50%)',
      };
    }
    return {
      left: clampedCenter,
      top: selectionTop - 10,
      transform: 'translate(-50%, -100%)',
    };
  };

  if (editable) {
    return (
      <div style={styles.root}>
        <canvas
          ref={canvasRef}
          style={{
            ...styles.canvas,
            ...(fullScreenOverlay ? styles.overlayCanvas : {}),
            cursor:
              phase === 'select' || tool !== 'text' ? 'crosshair' : 'text',
          }}
          aria-label="Screenshot annotation canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
        {phase === 'select' && (
          <div style={styles.selectionHint}>
            Drag to select an area · Esc to cancel
          </div>
        )}
        {phase === 'annotate' && selection && (
          <div
            style={{ ...styles.toolbar, ...toolbarPosition() }}
            role="toolbar"
            aria-label="Screenshot annotation tools"
          >
            <button
              type="button"
              style={styles.actionButton}
              aria-label="Reselect screenshot area"
              title="Select a different area"
              onClick={reselect}
            >
              <span aria-hidden="true">⌗</span> Crop
            </button>
            <span style={styles.divider} />
            {TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                style={{
                  ...styles.toolButton,
                  ...(tool === item.id ? styles.toolButtonActive : {}),
                }}
                aria-label={item.label}
                aria-pressed={tool === item.id}
                title={item.label}
                onClick={() => setTool(item.id)}
              >
                <ToolGlyph tool={item.id} />
              </button>
            ))}
            <span style={styles.divider} />
            {COLORS.map((item) => (
              <button
                key={item}
                type="button"
                style={{
                  ...styles.colorButton,
                  background: item,
                  ...(color === item ? styles.colorButtonActive : {}),
                }}
                aria-label={`Use ${item} annotation color`}
                aria-pressed={color === item}
                onClick={() => setColor(item)}
              />
            ))}
            <select
              style={styles.widthSelect}
              aria-label="Annotation line width"
              value={lineWidth}
              onChange={(event) => setLineWidth(Number(event.target.value))}
            >
              <option value={3}>Thin</option>
              <option value={5}>Medium</option>
              <option value={9}>Thick</option>
            </select>
            <span style={styles.divider} />
            <button
              type="button"
              style={{
                ...styles.toolButton,
                ...(annotations.length ? {} : styles.disabled),
              }}
              disabled={annotations.length === 0}
              aria-label="Undo annotation"
              title="Undo (Cmd/Ctrl+Z)"
              onClick={undo}
            >
              <span aria-hidden="true">↶</span>
            </button>
            <button
              type="button"
              style={{
                ...styles.toolButton,
                ...(redoStack.length ? {} : styles.disabled),
              }}
              disabled={redoStack.length === 0}
              aria-label="Redo annotation"
              title="Redo (Cmd/Ctrl+Shift+Z)"
              onClick={redo}
            >
              <span aria-hidden="true">↷</span>
            </button>
            <button
              type="button"
              style={styles.actionButton}
              aria-label="Cancel screenshot"
              onClick={closePreview}
            >
              Cancel
            </button>
            <button
              type="button"
              style={{ ...styles.actionButton, ...styles.saveButton }}
              aria-label="Save selected screenshot"
              onClick={saveAnnotation}
            >
              Done
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <button
        type="button"
        style={styles.backdrop}
        aria-label="Close image preview backdrop"
        onClick={closePreview}
      />
      {imageDataUrl && (
        <img
          src={imageDataUrl}
          alt="Preview of attachment"
          style={styles.image}
        />
      )}
      <button
        type="button"
        style={styles.close}
        aria-label="Close image preview"
        title="Close preview"
        onClick={closePreview}
      >
        ×
      </button>
    </div>
  );
}
