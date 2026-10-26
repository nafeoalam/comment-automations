/**
 * Normalizes text for matching: lowercase, strip accents and punctuation,
 * collapse whitespace. "¿Precio?" and "precio" normalize to the same string.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // combining accents
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if `phrase` appears in `text` as whole words (both already normalized). */
export function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;

/** Extracts the first plausible email address from free text, if any. */
export function extractEmail(text: string): string | undefined {
  const m = text.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : undefined;
}

/**
 * Extracts a plausible phone number (7 to 15 digits, optional leading +).
 * Deliberately simple; production would use libphonenumber with the
 * business's default region.
 */
export function extractPhone(text: string): string | undefined {
  const candidates = text.match(/\+?[\d\s().-]{7,}/g) ?? [];
  for (const c of candidates) {
    const digits = c.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      return (c.trim().startsWith("+") ? "+" : "") + digits;
    }
  }
  return undefined;
}

/** Fills {{product.name}} and {{product.link}} placeholders. Unknown slots are left as-is for the guardrail to catch. */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
}
