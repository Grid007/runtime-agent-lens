import { describe, expect, it } from "vitest";

import { expressionMentionsSecret, isSecretName, redactByName, REDACTED } from "../src/domain/redaction.js";
import { shapeVariable, truncateText } from "../src/domain/variables.js";

describe("redaction", () => {
  it("matches credential-like names only", () => {
    expect(isSecretName("api_key")).toBe(true);
    expect(isSecretName("DATABASE_PASSWORD")).toBe(true);
    expect(isSecretName("authToken")).toBe(true);
    expect(isSecretName("ConnectionString")).toBe(true);
    expect(isSecretName("total")).toBe(false);
    expect(isSecretName("items")).toBe(false);
  });

  it("redacts by name and never inspects the value", () => {
    expect(redactByName("password", "hunter2")).toEqual({ value: REDACTED, redacted: true });
    expect(redactByName("count", "hunter2")).toEqual({ value: "hunter2", redacted: false });
  });
});

describe("variable shaping", () => {
  it("truncates long values and reports the original length", () => {
    const result = truncateText("x".repeat(500), 20);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(20);
    expect(result.originalLength).toBe(500);
  });

  it("produces a bounded, redacted view", () => {
    const view = shapeVariable(
      { name: "secret_token", value: "abc", type: "str", variablesReference: 0 },
      { maxValueLength: 100, redact: redactByName },
    );
    expect(view.value).toBe(REDACTED);
    expect(view.redacted).toBe(true);
    const plain = shapeVariable(
      { name: "cart", value: "[...]", type: "list", variablesReference: 12, indexedVariables: 3 },
      { maxValueLength: 100, redact: redactByName },
    );
    expect(plain.child_count).toBe(3);
    expect(plain.variables_reference).toBe(12);
    expect(plain.redacted).toBeUndefined();
  });
});

describe("expressionMentionsSecret", () => {
  it("flags credential-looking names anywhere in the expression", () => {
    expect(expressionMentionsSecret("api_key")).toBe(true);
    expect(expressionMentionsSecret("api_key[:3]")).toBe(true);
    expect(expressionMentionsSecret("config.password")).toBe(true);
    expect(expressionMentionsSecret('os.environ["AUTH_TOKEN"]')).toBe(true);
    expect(expressionMentionsSecret("len(client_secret)")).toBe(true);
  });
  it("leaves ordinary expressions alone", () => {
    expect(expressionMentionsSecret("total / count")).toBe(false);
    expect(expressionMentionsSecret("items[0].price")).toBe(false);
    expect(expressionMentionsSecret("1 + 2")).toBe(false);
  });
});
