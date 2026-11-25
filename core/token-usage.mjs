function geminiModelTotals(models) {
  const totals = {};
  for (const model of Object.values(models)) {
    const t = model?.tokens ?? model;
    if (!t) continue;
    // Gemini CLI's prompt includes cached tokens. Its input is the uncached remainder.
    const prompt = t.prompt ?? t.input_tokens ?? (t.input + (t.cached ?? 0));
    const candidates = t.candidates ?? t.output_tokens;
    const counts = { input_tokens: prompt, cached_input_tokens: t.cached, output_tokens: candidates,
      reasoning_tokens: t.thoughts,
      total_tokens: t.total ?? t.total_tokens ?? (prompt + candidates + (t.thoughts ?? 0) + (t.tool ?? 0)) };
    for (const [field, count] of Object.entries(counts)) {
      if (Number.isSafeInteger(count) && count >= 0) totals[field] = (totals[field] ?? 0) + count;
    }
  }
  return totals;
}

// Canonical input includes cache hits and writes. Providers differ on whether
// those are already counted in their input field.
export function normalizeUsage(raw = {}) {
  const models = raw.models ? geminiModelTotals(raw.models) : {};
  const includedRead = raw.cached_input_tokens ?? raw.cachedInputTokens ?? raw.input_tokens_details?.cached_tokens
    ?? raw.prompt_tokens_details?.cached_tokens ?? raw.cachedContentTokenCount ?? raw.cached ?? raw.cached_tokens;
  const read = includedRead ?? raw.cache_read_input_tokens ?? raw.cache_read_tokens ?? raw.cache?.read;
  const write = raw.cache_creation_input_tokens ?? raw.cache_write_tokens ?? raw.cacheWriteInputTokens ?? raw.cache?.write;
  let input = raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens ?? raw.promptTokenCount ?? models.input_tokens ?? raw.input;
  const exclusive = includedRead == null && (raw.cache_read_input_tokens != null
    || raw.cache_read_tokens != null || raw.cache_creation_input_tokens != null || raw.cache != null);
  if (Number.isFinite(input) && exclusive) input += (read ?? 0) + (write ?? 0);
  const output = raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens ?? raw.candidatesTokenCount ?? raw.output ?? models.output_tokens;
  const fields = {
    input_tokens: input, output_tokens: output, cached_input_tokens: read ?? models.cached_input_tokens,
    cache_write_tokens: write,
    reasoning_tokens: raw.reasoning_tokens ?? raw.reasoningOutputTokens ?? raw.thoughtsTokenCount ?? raw.reasoning
      ?? raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens ?? models.reasoning_tokens,
    total_tokens: raw.total_tokens ?? raw.totalTokens ?? raw.totalTokenCount ?? raw.total ?? models.total_tokens ?? (input + output),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
}

export function cacheHitRatio(usage) {
  return usage.input_tokens > 0 && usage.cached_input_tokens != null
    ? Math.min(1, usage.cached_input_tokens / usage.input_tokens) : null;
}
