/** Keep currency amounts from opening inline LaTeX spans.
 * Code, escaped characters, and explicit $$ math retain their original source.
 */
export function currencySafeMarkdown(text: string): string {
  return text.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|(`+)[^`]*?\2|\\[\s\S]|\$\$[\s\S]*?\$\$|\$(?=\d[\d,]*(?:\.\d+)?(?:[ \t]+[a-zA-Z]{2,}\b|[.,;:!?](?:\s|$)|$))/g,
    (match) => (match === '$' ? '\\$' : match),
  );
}
