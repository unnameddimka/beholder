// Chat text rendering: plain text with *asterisk-delimited actions* shown as italic action spans (delimiters hidden).
// Not Markdown. Output is built with DOM text nodes only, so user or model text can never inject HTML.

// Splits text into ordered text/action segments. An unmatched or empty pair of asterisks stays literal.
export function tokenizeActions(text) {
  const source = String(text ?? "");
  const segments = [];
  const pattern = /\*([^*]+)\*/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (!match[1].trim()) continue;
    if (match.index > last) segments.push({ type: "text", text: source.slice(last, match.index) });
    segments.push({ type: "action", text: match[1] });
    last = match.index + match[0].length;
  }
  if (last < source.length) segments.push({ type: "text", text: source.slice(last) });
  return segments;
}

export function renderMessageText(text, doc = document) {
  const fragment = doc.createDocumentFragment();
  for (const segment of tokenizeActions(text)) {
    if (segment.type === "action") {
      const span = doc.createElement("span");
      span.className = "action";
      span.textContent = segment.text;
      fragment.appendChild(span);
    } else {
      fragment.appendChild(doc.createTextNode(segment.text));
    }
  }
  return fragment;
}
