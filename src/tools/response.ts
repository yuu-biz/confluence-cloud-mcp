const DEFAULT_MAX_CHARS = 12_000;

function shrink(value: unknown, depth: number): unknown {
  if (depth > 7) return '[depth omitted]';
  if (typeof value === 'string')
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…[truncated]` : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => shrink(item, depth + 1));
    if (value.length > items.length)
      items.push(`[${value.length - items.length} more items omitted]`);
    return items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shrink(item, depth + 1)]),
    );
  }
  return value;
}

export function boundedJson(value: unknown, maxChars = DEFAULT_MAX_CHARS): string {
  const safeMax = Math.max(1_000, Math.min(maxChars, 50_000));
  let current: unknown = value;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const text = JSON.stringify(current, null, 2);
    if (text.length <= safeMax) return text;
    current = shrink(current, 0);
    if (attempt >= 1 && Array.isArray(current))
      current = current.slice(0, Math.max(1, Math.floor(current.length / 2)));
    if (attempt >= 2 && current && typeof current === 'object' && !Array.isArray(current)) {
      const entries = Object.entries(current as Record<string, unknown>);
      current = Object.fromEntries(entries.slice(0, Math.max(1, Math.floor(entries.length / 2))));
    }
  }
  const finalText = JSON.stringify(current);
  return `${finalText.slice(0, safeMax - 40)}…[response truncated to ${safeMax} characters]`;
}

export function toolResult(value: unknown, maxChars?: number) {
  return { content: [{ type: 'text' as const, text: boundedJson(value, maxChars) }] };
}
