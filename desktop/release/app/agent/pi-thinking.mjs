/** Gemini's thinking-off mapping can emit MINIMAL, which newer models reject. */
export function isHostedQwen(model) {
  return /^hosted_vllm\/(?:.*\/)?qwen3[.\-]/i.test(model);
}

export function chatThinkingLevel(model, configured) {
  if (configured && configured !== 'default')
    return configured === 'on' ? 'medium' : configured;
  return model.reasoning &&
    ['google-generative-ai', 'google-vertex'].includes(model.api) &&
    model.id.toLowerCase().includes('gemini')
    ? 'low'
    : 'off';
}
