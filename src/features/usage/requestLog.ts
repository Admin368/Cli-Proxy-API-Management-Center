/** Only show body sections; request/response headers never enter the rendered inspector. */
export function parseRequestLog(text: string): {
  request: string;
  response: string;
  status: string;
} {
  const sections = new Map<string, string>();
  const normalized = text.replace(/\r\n/g, '\n');
  const markers = [...normalized.matchAll(/^=== ([A-Z ]+) ===\s*$/gm)];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    sections.set(
      marker[1],
      normalized
        .slice(marker.index! + marker[0].length, markers[i + 1]?.index ?? normalized.length)
        .trim()
    );
  }
  const rawResponse = sections.get('RESPONSE') ?? '';
  const boundary = rawResponse.indexOf('\n\n');
  const response = boundary >= 0 ? rawResponse.slice(boundary + 2).trim() : '';
  const pretty = (value: string) => {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  };
  return {
    request: pretty(sections.get('REQUEST BODY') ?? ''),
    response: pretty(response),
    status: rawResponse.match(/^Status: (\d+)/)?.[1] ?? '',
  };
}
