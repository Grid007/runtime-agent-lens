/** Names that usually hold credentials. Matching is by name only, never by value. */
const SECRET_NAME_PATTERN =
  /(passw(or)?d|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential|connection[_-]?string|cookie|session[_-]?id|bearer)/i;

/** Names that contain a secret word but describe a number, size or kind, not a credential (token_count, max_tokens). */
const BENIGN_NAME_PATTERN =
  /((^|_)(num|max|min|total|count|n)_?tokens?$)|(tokens?_?(count|len|length|limit|budget|size|usage|total|num|max|min|idx|index|type|kind|ttl|expiry|expires|expires_at|expires_in)$)/;

export const REDACTED = "[REDACTED]";

const normalizeName = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();

export const isSecretName = (name: string): boolean =>
  SECRET_NAME_PATTERN.test(name) && !BENIGN_NAME_PATTERN.test(normalizeName(name));

/** Returns the redaction marker for secret-looking names, else the value untouched. */
export const redactByName = (name: string, value: string): { value: string; redacted: boolean } =>
  isSecretName(name) ? { value: REDACTED, redacted: true } : { value, redacted: false };

/**
 * Shapes that are credentials wherever they appear: JWTs, Authorization headers, well-known key prefixes,
 * private key blocks, credentials inside URLs and `password=...` style assignments. Replaced in place so
 * the rest of the value stays readable.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{12,}=*/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];

/** Patterns that keep a prefix (the scheme, the key name) so the rest of the text still reads. */
const PREFIXED_PATTERNS: readonly RegExp[] = [
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
  /(\b(?:passw(?:or)?d|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*['"]?)[^\s'",;&]{4,}/gi,
];

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Mask credential-shaped substrings in a value regardless of the name it is stored under. */
export const redactValuePatterns = (value: string): { value: string; redacted: boolean } => {
  if (PRIVATE_KEY_BLOCK.test(value)) return { value: REDACTED, redacted: true };
  let result = value;
  for (const pattern of VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  for (const pattern of PREFIXED_PATTERNS) {
    result = result.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}${prefix.endsWith("://") ? "@" : ""}`);
  }
  return { value: result, redacted: result !== value };
};

/** Name first, then value shapes. What variable listings and evaluate results go through. */
export const redactVariable = (name: string, value: string): { value: string; redacted: boolean } => {
  const byName = redactByName(name, value);
  return byName.redacted ? byName : redactValuePatterns(value);
};

/**
 * True when an expression names something credential-looking: any identifier or quoted key in it
 * matches a secret name (api_key, os.environ["TOKEN"], password[:3]). Name-only, like the rest of redaction;
 * it errs towards hiding, so tokenize(x) also matches.
 */
export const expressionMentionsSecret = (expression: string): boolean => {
  const words = expression.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return words.some(isSecretName);
};

/**
 * A line of source shown next to a stop. Credential-shaped text is masked, and a literal assigned to a
 * credential-looking name (api_key = "...") is replaced.
 */
export const redactSourceLine = (line: string): string => {
  const assignment = /^(.*?[^=!<>])=(?!=)\s*(["'`].*|\d.*)$/.exec(line);
  const target = assignment?.[1];
  if (assignment !== null && target !== undefined && expressionMentionsSecret(target)) return `${target}= ${REDACTED}`;
  return redactValuePatterns(line).value;
};
