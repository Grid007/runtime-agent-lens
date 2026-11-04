/** Calls to these are treated as side-effect free. Anything else that looks like a call is refused. */
const PURE_CALLS = new Set(["len", "repr", "str", "type", "int", "float", "bool", "abs", "min", "max", "sum", "round", "isinstance"]);

/** Words that may legally precede a parenthesis without being a call. */
const NOT_CALLS = new Set(["if", "else", "elif", "and", "or", "not", "in", "is", "for", "while", "return", "typeof", "void"]);

const FORBIDDEN_WORDS = ["lambda", "import", "exec", "eval", "del", "delete", "new", "await", "yield", "global", "nonlocal", "async", "function"];

const stripStrings = (expression: string): { text: string; hasTemplateExpression: boolean } => {
  let text = "";
  let hasTemplateExpression = false;
  let quote: string | undefined;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression.charAt(i);
    if (quote !== undefined) {
      if (ch === "\\") i += 1;
      else if (quote === "`" && ch === "$" && expression.charAt(i + 1) === "{") hasTemplateExpression = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      text += '""';
      continue;
    }
    text += ch;
  }
  return { text, hasTemplateExpression };
};

/**
 * Heuristic check used when mutation is disabled: returns why an expression may change the program, or
 * undefined when it only reads names, attributes, subscripts and arithmetic. This is a guard against
 * accidents by an agent, not a sandbox: property getters and operator overloads can still run code.
 */
export const findSideEffect = (expression: string): string | undefined => {
  const { text, hasTemplateExpression } = stripStrings(expression);
  if (hasTemplateExpression) return "a template literal with an embedded expression";

  for (let i = 0; i < text.length; i += 1) {
    if (text.charAt(i) !== "=") continue;
    const next = text.charAt(i + 1);
    const prev = text.charAt(i - 1);
    if (next === "=") {
      i += text.charAt(i + 2) === "=" ? 2 : 1;
      continue;
    }
    if (prev === "!" || prev === "<" || prev === ">" || next === ">") continue;
    return "an assignment";
  }
  if (/[\w$)\]](\+\+|--)|(\+\+|--)[\w$(]/.test(text)) return "an increment or decrement";

  for (const word of FORBIDDEN_WORDS) {
    if (new RegExp(`(^|[^\\w$.])${word}($|[^\\w$])`).test(text)) return `the keyword '${word}'`;
  }

  const call = /([A-Za-z_$][\w$]*|\]|\))\s*\(/g;
  for (let match = call.exec(text); match !== null; match = call.exec(text)) {
    const callee = match[1] ?? "";
    if (callee === "]" || callee === ")") return "a call on a computed value";
    if (NOT_CALLS.has(callee)) continue;
    const isMethod = text.charAt(match.index - 1) === ".";
    if (!isMethod && PURE_CALLS.has(callee)) continue;
    return `a call to ${callee}()`;
  }
  return undefined;
};
