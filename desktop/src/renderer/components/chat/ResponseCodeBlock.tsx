import { isValidElement, useState, type ComponentPropsWithoutRef } from 'react';
import type { ExtraProps } from 'react-markdown';
import CodeWindow from './CodeWindow';
import './ResponseCodeBlock.css';

export default function ResponseCodeBlock({
  children,
  className,
}: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const [expanded, setExpanded] = useState(false);
  const code = isValidElement<{ children?: unknown; className?: string }>(
    children,
  )
    ? children.props
    : null;
  // Keep non-code elements (including rendered math) in their original form.
  if (typeof code?.children !== 'string')
    return <pre className={className}>{children}</pre>;
  const source = code.children;
  // Markdown adds a terminal newline; don't count it as a hidden blank line.
  const lines = source.replace(/\n$/, '').split('\n');
  const hiddenLines = Math.max(0, lines.length - 4);
  const longLine = lines.some((line) => line.length > 160);
  if (lines.length <= 8 && !longLine)
    return <pre className={className}>{children}</pre>;
  const language =
    /(?:^|\s)language-([^\s]+)/.exec(code.className ?? '')?.[1] ?? 'auto';
  const preview = lines
    .slice(0, 4)
    .map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line))
    .join('\n');
  return (
    <div className="response-code-block">
      <pre className={className}>
        <code className={code.className}>{preview}</code>
      </pre>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Show full code block"
      >
        {hiddenLines ? `+ ${hiddenLines} lines` : 'Show full code'}{' '}
        <span aria-hidden="true">↗</span>
      </button>
      {expanded && (
        <CodeWindow
          title={language === 'auto' ? 'Code' : `${language} code`}
          source={source}
          language={language}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  );
}
