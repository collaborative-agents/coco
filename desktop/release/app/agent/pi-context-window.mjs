// Resolve Coco's provider/model names against Pi's refreshed model catalog.
// Do not infer a self-hosted server's configured capacity from its model name.
export function contextWindowForModel(selectedModel, models) {
  const slash = selectedModel.indexOf('/');
  if (slash < 0) return 64000;
  const prefix = selectedModel.slice(0, slash);
  const provider = prefix === 'gemini' ? 'google' : prefix;
  if (!['google', 'anthropic', 'openai', 'openai-codex', 'deepseek'].includes(provider))
    return 64000;
  const id = selectedModel.slice(slash + 1);
  const matches = models.filter((model) => model.provider === provider && model.id === id);
  const windows = matches.map((model) => model.contextWindow).filter(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
  // Multiple API variants may expose the same model; honor the smallest limit.
  return windows.length ? Math.min(...windows) : 64000;
}
