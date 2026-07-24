import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { ToolCallCard } from '../renderer/components/SessionChatView';

describe('Tutor tool-call visualization', () => {
  it('shows on-demand screen observation progress and evidence', () => {
    const { rerender } = render(
      <ToolCallCard
        call={{
          id: 'tool-screen',
          name: 'observe_screen',
          arguments: { focus: 'Identify the visible error' },
          status: 'running',
        }}
      />,
    );

    expect(screen.getByText('Current screen')).toBeInTheDocument();
    expect(screen.getByText('Observing…')).toBeInTheDocument();

    rerender(
      <ToolCallCard
        call={{
          id: 'tool-screen',
          name: 'observe_screen',
          arguments: { focus: 'Identify the visible error' },
          status: 'completed',
          result: {
            observation: 'A spreadsheet shows a #VALUE! error in cell D12.',
          },
        }}
      />,
    );

    expect(screen.getByText('Observed')).toBeInTheDocument();
    expect(screen.getByText('View screen observation')).toBeInTheDocument();
    expect(
      screen.getByText('A spreadsheet shows a #VALUE! error in cell D12.'),
    ).toBeInTheDocument();
  });

  it('shows observation query arguments, status, and retrieved content', () => {
    render(
      <ToolCallCard
        call={{
          id: 'tool-1',
          name: 'get_user_context',
          arguments: {
            query: 'roadmap',
            start_hh_mm_ago: '01:00',
            end_hh_mm_ago: '00:15',
            limit: 3,
            evidence_limit: 1,
          },
          status: 'completed',
          result: {
            count: 1,
            results: [
              {
                id: 'memory-1',
                text: 'The user is reviewing a roadmap in Notion',
                updated_at: '2026-07-22T18:30:00+00:00',
                evidence: [
                  {
                    id: 'observation-1',
                    content: 'Reviewing a roadmap in Notion',
                  },
                ],
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText('get_user_context')).toBeInTheDocument();
    expect(screen.getByText('1 found')).toBeInTheDocument();
    expect(screen.getByText(/“roadmap”/)).toHaveTextContent(
      '“roadmap” · 01:00 → 00:15 ago · limit 3 · evidence 1',
    );
    expect(
      screen.getByText('The user is reviewing a roadmap in Notion'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Evidence: Reviewing a roadmap in Notion'),
    ).toHaveTextContent('Evidence: Reviewing a roadmap in Notion');
  });
});
