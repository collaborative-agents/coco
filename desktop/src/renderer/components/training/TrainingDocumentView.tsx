/* eslint-disable react/require-default-props -- React 19 uses default function parameters. */
import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TrainingDocument } from '../../../shared/training-materials';
import PdfTaskBrief from './PdfTaskBrief';

const markdownComponents: Components = {
  a: ({ href, children }) =>
    /^https?:\/\//i.test(href ?? '') ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span>{alt}</span>,
};

export default function TrainingDocumentView({
  document,
  referenceDownload = null,
}: {
  document: TrainingDocument;
  referenceDownload?: ReactNode;
}) {
  if (document.kind === 'pdf')
    return (
      <PdfTaskBrief document={document} referenceDownload={referenceDownload} />
    );
  return (
    <>
      {document.kind === 'text' ? (
        <div className="training-document-text">{document.content}</div>
      ) : (
        <div className="training-document-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={markdownComponents}
          >
            {document.content}
          </Markdown>
        </div>
      )}
      {referenceDownload && (
        <section className="training-reference-files">
          <h3>Reference files</h3>
          {referenceDownload}
        </section>
      )}
    </>
  );
}
