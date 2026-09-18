const DEFAULT_MAX_CHARS = 12_000;
const MIN_MAX_CHARS = 1_000;
const HARD_MAX_CHARS = 50_000;

export interface OutputBudget {
  requestedChars?: number | undefined;
  effectiveChars: number;
  hardCapChars: number;
  defaultChars: number;
}

/**
 * Resolves the caller's max_chars against the server hard cap so tools can report the budget
 * they actually rendered against instead of silently returning less than was asked for.
 */
export function resolveOutputBudget(requested?: number): OutputBudget {
  return {
    requestedChars: requested,
    effectiveChars: Math.max(
      MIN_MAX_CHARS,
      Math.min(requested ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS),
    ),
    hardCapChars: HARD_MAX_CHARS,
    defaultChars: DEFAULT_MAX_CHARS,
  };
}

interface ShrinkLimits {
  depth: number;
  arrayItems: number;
  stringChars: number;
}

// Applied least aggressive first, so a response that only slightly exceeds the budget keeps its
// nested structure instead of collapsing every deep node into a placeholder.
const SHRINK_PROFILES: ShrinkLimits[] = [
  { depth: 14, arrayItems: 250, stringChars: 6_000 },
  { depth: 12, arrayItems: 150, stringChars: 3_000 },
  { depth: 10, arrayItems: 100, stringChars: 2_000 },
  { depth: 8, arrayItems: 50, stringChars: 1_000 },
  { depth: 6, arrayItems: 25, stringChars: 500 },
];

function shrink(value: unknown, depth: number, limits: ShrinkLimits): unknown {
  if (depth > limits.depth) return '[depth omitted]';
  if (typeof value === 'string')
    return value.length > limits.stringChars
      ? `${value.slice(0, limits.stringChars)}…[truncated]`
      : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, limits.arrayItems).map((item) => shrink(item, depth + 1, limits));
    if (value.length > items.length)
      items.push(`[${value.length - items.length} more items omitted]`);
    return items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shrink(item, depth + 1, limits)]),
    );
  }
  return value;
}

export function boundedJson(value: unknown, maxChars = DEFAULT_MAX_CHARS): string {
  const { effectiveChars } = resolveOutputBudget(maxChars);
  const direct = JSON.stringify(value, null, 2);
  if (direct.length <= effectiveChars) return direct;

  let current: unknown = value;
  for (const limits of SHRINK_PROFILES) {
    current = shrink(value, 0, limits);
    const text = JSON.stringify(current, null, 2);
    if (text.length <= effectiveChars) return text;
  }
  const finalText = JSON.stringify(current);
  return `${finalText.slice(0, Math.max(0, effectiveChars - 60))}…[response truncated to ${effectiveChars} characters]`;
}

export function toolResult(value: unknown, maxChars?: number) {
  return { content: [{ type: 'text' as const, text: boundedJson(value, maxChars) }] };
}
