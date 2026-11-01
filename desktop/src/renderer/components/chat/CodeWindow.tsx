import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import typescript from 'highlight.js/lib/languages/typescript';
import './ToolActivity.css';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('typescript', typescript);

export default function CodeWindow({
  title,
  source,
  language,
  onClose,
}: {
  title: string;
  source: string;
  language: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [copyStatus, setCopyStatus] = useState('');
  const highlighted = useMemo(() => {
    if (
      language === 'text' ||
      (language !== 'auto' && !hljs.getLanguage(language))
    )
      return null;
    return language === 'auto'
      ? hljs.highlightAuto(source, ['bash', 'python', 'javascript', 'json'])
          .value
      : hljs.highlight(source, { language }).value;
  }, [source, language]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Could not copy. Select the code to copy it.');
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="tool-code-window"
      aria-labelledby={titleId}
      onCancel={onClose}
      onClose={onClose}
    >
      <header>
        <div>
          <h2 id={titleId}>{title}</h2>
          <span>{source.replace(/\n$/, '').split('\n').length} lines</span>
        </div>
        <button type="button" onClick={copy}>
          Copy
        </button>
        <button type="button" onClick={onClose} aria-label="Close code window">
          Close
        </button>
      </header>
      {copyStatus && (
        <div className="tool-code-copy-status" role="status">
          {copyStatus}
        </div>
      )}
      {/* Allow keyboard users to scroll long source in both directions. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre tabIndex={0}>
        {highlighted === null ? (
          <code>{source}</code>
        ) : (
          // highlight.js escapes source text before adding its own token spans.
          // eslint-disable-next-line react/no-danger
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        )}
      </pre>
    </dialog>,
    document.body,
  );
}
