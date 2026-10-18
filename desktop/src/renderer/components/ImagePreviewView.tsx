import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'relative',
    display: 'flex',
    width: '100vw',
    height: '100vh',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    background: 'rgba(17, 24, 39, 0.94)',
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

export default function ImagePreviewView() {
  const [imageDataUrl, setImageDataUrl] = useState('');

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'image-preview',
      (payload: unknown) => {
        const image = (payload as { imageDataUrl?: unknown } | null)
          ?.imageDataUrl;
        if (typeof image === 'string' && image.startsWith('data:image/')) {
          setImageDataUrl(image);
        }
      },
    );
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePreview();
    };
    window.addEventListener('keydown', closeOnEscape);
    window.electron?.ipcRenderer.sendMessage('image-preview-ready');
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

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
