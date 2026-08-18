export function sessionTitle(task: string, maxChars = 72): string {
  const normalized = task.replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
  const concise = normalized.replace(/^(what|which|who|where|when|why|how)\s+(is|are|does|do)\s+(the\s+)?/i, '');
  const title = concise === '' ? normalized : concise;
  const capped = title.slice(0, maxChars).trim();

  return capped === '' ? 'New session' : capped.charAt(0).toUpperCase() + capped.slice(1);
}
