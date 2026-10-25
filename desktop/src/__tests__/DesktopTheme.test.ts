import { readFileSync } from 'fs';
import path from 'path';
import { S } from '../renderer/components/chat/styles';

const css = (file: string) =>
  readFileSync(path.join(__dirname, '../renderer', file), 'utf8');
const tokens = css('theme/tokens.css');

describe('shared desktop typography', () => {
  it('defines one readable scale for body, controls, and secondary text', () => {
    expect(tokens).toContain('--coco-text-body: 16px');
    expect(tokens).toContain('--coco-text-control: 14px');
    expect(tokens).toContain('--coco-text-secondary: 13px');
    expect(tokens).toContain('--coco-text-caption: 12px');
    expect(css('global.css')).toContain("@import './theme/tokens.css'");
  });

  it('uses body typography for chat messages and the composer', () => {
    [
      'userBubble',
      'tutorBubble',
      'errBubble',
      'textarea',
      'memoryArea',
    ].forEach((name) => {
      expect(S[name].fontSize).toBe('var(--coco-text-body)');
    });
    expect(S.userBubble.lineHeight).toBe('var(--coco-leading-body)');
    expect(S.tutorBubble.lineHeight).toBe('var(--coco-leading-body)');
    expect(S.textarea.minWidth).toBe(0);
  });

  it('uses shared control sizes without enlarging the entire window', () => {
    [
      'sendBtn',
      'finishTaskBtn',
      'newSessionBtn',
      'customInput',
      'screenTaskBtn',
    ].forEach((name) => {
      expect(S[name].fontSize).toBe('var(--coco-text-control)');
    });
    expect(S.iconBtn.height).toBe('var(--coco-control-height)');
    expect(S.newSessionBtn.height).toBeGreaterThanOrEqual(28);
    expect(tokens).toContain('--coco-control-height: 36px');
    expect(S.hotkeyHint.fontSize).toBe('var(--coco-text-secondary)');
    expect(S.metricRow.fontSize).toBe('var(--coco-text-caption)');
  });

  it('shares the scale across setup and chat surfaces', () => {
    const pages = [
      'components/OnboardingView.css',
      'components/setup/SetupShell.css',
      'components/chat/DesktopWorkspace.css',
      'components/chat/MessageContent.css',
      'App.css',
    ];
    pages.forEach((file) =>
      expect(css(file)).toMatch(/var\(--coco-text-(body|control|secondary)\)/),
    );
    expect(css('App.css')).not.toMatch(/font(?:-family)?:[^;]*-apple-system/);
  });

  it('keeps composer actions below a full-width input and distinguishes prompt cards', () => {
    expect(S.textarea.width).toBe('100%');
    expect(S.textarea.border).toBe('none');
    expect(S.composerActions.alignItems).toBe('center');
    expect(S.composerActions.flexWrap).toBe('wrap');
    expect(S.micBtn.width).toBe(S.sendBtn.width);
    expect(S.micBtn.height).toBe(S.sendBtn.height);
    expect(S.secondaryPromptBtn.background).toBe('var(--coco-color-surface)');
    expect(S.screenTaskBtn.background).toBe('var(--coco-color-accent-soft)');
    expect(S.secondaryPromptBtn.fontSize).toBe(S.screenTaskBtn.fontSize);
    expect(S.finishTaskBtn.background).toBe('var(--coco-color-primary)');
    expect(S.finishTaskBtn.color).toBe('var(--coco-color-surface)');
  });

  it('removes input focus highlights without changing button focus indicators', () => {
    const composerCss = css('components/chat/ChatComposer.css');
    expect(composerCss).not.toContain(':focus-within');
    expect(composerCss).toMatch(
      /textarea:focus-visible\s*\{\s*outline: none;\s*box-shadow: none;/,
    );
    expect(composerCss).not.toContain('button:focus');
    expect(css('global.css')).toContain('box-shadow: var(--coco-focus-ring)');
  });
});
