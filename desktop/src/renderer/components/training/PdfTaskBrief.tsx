/* eslint-disable react/require-default-props -- React 19 uses default function parameters. */
import { useEffect, useState, type ReactNode } from 'react';
import type { TrainingDocument } from '../../../shared/training-materials';
import extractPdfText from './extract-pdf-text';
import parseTaskBrief, { briefParagraphs, type TaskBrief } from './task-brief';
import './TaskBrief.css';

function SectionText({ text }: { text: string }) {
  const blocks = briefParagraphs(text).reduce<
    { list: boolean; texts: string[] }[]
  >((groups, block) => {
    const previous = groups.at(-1);
    if (block.list && previous?.list) previous.texts.push(block.text);
    else groups.push({ list: block.list, texts: [block.text] });
    return groups;
  }, []);
  return (
    <>
      {blocks.map((block, index) =>
        block.list ? (
          // These immutable blocks have no identity other than their order in the source.
          // eslint-disable-next-line react/no-array-index-key
          <ul key={index}>
            {block.texts.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <p key={index}>{block.texts[0]}</p>
        ),
      )}
    </>
  );
}

export default function PdfTaskBrief({
  document,
  referenceDownload = null,
}: {
  document: TrainingDocument;
  referenceDownload?: ReactNode;
}) {
  const [brief, setBrief] = useState<TaskBrief | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setBrief(null);
    setError('');
    extractPdfText(document.content)
      .then((text) => {
        if (active) setBrief(parseTaskBrief(text, document.name));
        return undefined;
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [document, retry]);
  if (error)
    return (
      <>
        <div role="alert" className="training-error">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry instructions
          </button>
        </div>
        {referenceDownload}
      </>
    );
  if (!brief) return <p role="status">Preparing your task brief…</p>;
  const mission = brief.sections.filter(
    (section) => section.title === 'Your mission',
  );
  const primary = mission.length
    ? mission
    : brief.sections.filter((section) => section.title === 'Your task');
  return (
    <article className="training-task-brief">
      <div className="post-assessment-mission">
        <h3>{brief.title}</h3>
        {primary.map((section) => (
          <SectionText key={section.title} text={section.text} />
        ))}
        {brief.sections
          .filter((section) => section.title === 'Background')
          .map((section) => (
            <details key={section.title} open={primary.length === 0}>
              <summary>Background</summary>
              <SectionText text={section.text} />
            </details>
          ))}
      </div>
      {brief.sections
        .filter(
          (section) =>
            !primary.includes(section) && section.title !== 'Background',
        )
        .map((section) => (
          <section
            className={
              [
                'Deliverables',
                'Success criteria',
                'Success checklist',
              ].includes(section.title)
                ? 'training-brief-outcome'
                : ''
            }
            key={section.title}
          >
            <h4>{section.title}</h4>
            <SectionText text={section.text} />
            {section.title === 'Reference files' && referenceDownload}
          </section>
        ))}
      {!brief.sections.some((section) => section.title === 'Reference files') &&
        referenceDownload && (
          <section>
            <h4>Reference files</h4>
            {referenceDownload}
          </section>
        )}
    </article>
  );
}
