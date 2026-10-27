import DOMPurify from "dompurify";

/**
 * Every dangerouslySetInnerHTML call site in this app renders descriptionHtmlEn (aiListingDraft),
 * an LLM's own HTML output written straight into the DB with no markup validation -- the model
 * is prompted for "HTML description in English" (packages/ai/src/prompt.ts) built from BASE
 * product data a tenant controls. An indirect prompt injection in that source data (a product
 * title/description instructing the model to emit a <script>/onerror handler) would otherwise
 * become stored XSS in the operator's own authenticated admin dashboard the moment they open
 * that product's draft. Sanitize at render time rather than trust the model's output as safe
 * markup -- defense in depth even if the prompt/model also gets hardened separately.
 */
export function sanitizeDraftHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "h3", "h4", "span", "div", "a", "img", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "style", "class"],
    ALLOW_DATA_ATTR: false,
  });
}
