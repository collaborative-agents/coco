/** Gemini's thinking-off mapping can emit MINIMAL, which newer models reject. */
export function chatThinkingLevel(model) {
  return model.reasoning &&
    ['google-generative-ai', 'google-vertex'].includes(model.api) &&
    model.id.toLowerCase().includes('gemini')
    ? 'low'
    : 'off';
}
