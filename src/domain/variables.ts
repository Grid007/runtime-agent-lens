/** Bound a display string and report whether anything was dropped. */
export const truncateText = (
  text: string,
  maxLength: number,
): { text: string; truncated: boolean; originalLength: number } => {
  if (text.length <= maxLength) return { text, truncated: false, originalLength: text.length };
  const head = Math.max(0, maxLength - 1);
  return { text: `${text.slice(0, head)}…`, truncated: true, originalLength: text.length };
};

/** DAP Variable as returned by the `variables` request. */
export interface DapVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly variablesReference: number;
  readonly namedVariables?: number;
  readonly indexedVariables?: number;
  readonly evaluateName?: string;
  readonly presentationHint?: { readonly kind?: string; readonly attributes?: readonly string[] };
}

export interface VariableView {
  name: string;
  value: string;
  type?: string;
  variables_reference: number;
  evaluate_name?: string;
  kind?: string;
  truncated?: boolean;
  original_length?: number;
  redacted?: boolean;
  child_count?: number;
  children?: VariableView[];
  children_truncated?: boolean;
}

export interface ShapeOptions {
  readonly maxValueLength: number;
  readonly redact: (name: string, value: string) => { value: string; redacted: boolean };
}

export const shapeVariable = (variable: DapVariable, options: ShapeOptions): VariableView => {
  const redacted = options.redact(variable.name, variable.value);
  const bounded = truncateText(redacted.value, options.maxValueLength);
  const childCount =
    (variable.namedVariables ?? 0) + (variable.indexedVariables ?? 0) || undefined;
  const view: VariableView = {
    name: variable.name,
    value: bounded.text,
    variables_reference: variable.variablesReference,
  };
  if (variable.type !== undefined) view.type = variable.type;
  if (variable.evaluateName !== undefined) view.evaluate_name = variable.evaluateName;
  if (variable.presentationHint?.kind !== undefined) view.kind = variable.presentationHint.kind;
  if (bounded.truncated) {
    view.truncated = true;
    view.original_length = bounded.originalLength;
  }
  if (redacted.redacted) view.redacted = true;
  if (childCount !== undefined) view.child_count = childCount;
  return view;
};
