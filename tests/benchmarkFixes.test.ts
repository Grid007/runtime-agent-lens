import { describe, expect, it } from "vitest";

import { findSideEffect } from "../src/domain/expressionGuard.js";
import {
  expressionMentionsSecret,
  isSecretName,
  redactSourceLine,
  redactValuePatterns,
  redactVariable,
} from "../src/domain/redaction.js";

describe("findSideEffect", () => {
  it("allows reads, arithmetic and pure builtins", () => {
    for (const ok of ["total", "items[0].price", "total / count", "len(items) > 3", "repr(x)", "a == b", "a <= b", "a != b", "x if y else z", 'name == "a=b"', "min(a, b) + max(c, d)"]) {
      expect(findSideEffect(ok), ok).toBeUndefined();
    }
  });

  it("refuses calls, assignments and the other ways to change the program", () => {
    const cases: Array<[string, string]> = [
      ["big_list.clear()", "a call to clear()"],
      ["os.remove(path)", "a call to remove()"],
      ["x = 1", "an assignment"],
      ["x += 1", "an assignment"],
      ["(y := 3)", "an assignment"],
      ["count++", "an increment or decrement"],
      ["__import__('os')", "a call to __import__()"],
      ["lambda: 1", "the keyword 'lambda'"],
      ["fns[0]()", "a call on a computed value"],
      ["`${doIt()}`", "a template literal with an embedded expression"],
    ];
    for (const [expression, reason] of cases) expect(findSideEffect(expression), expression).toBe(reason);
  });

  it("ignores operators and calls that only appear inside string literals", () => {
    expect(findSideEffect('label == "clear() = 1"')).toBeUndefined();
  });
});

describe("value redaction", () => {
  it("masks a JWT and a bearer header wherever they sit", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    expect(redactValuePatterns(jwt)).toEqual({ value: "[REDACTED]", redacted: true });
    const header = redactValuePatterns("{'Authorization': 'Bearer abcdef1234567890xyz', 'Accept': 'json'}");
    expect(header.redacted).toBe(true);
    expect(header.value).toContain("'Accept': 'json'");
    expect(header.value).not.toContain("abcdef1234567890xyz");
  });

  it("masks well-known key shapes, credentials in URLs and key=value text", () => {
    for (const secret of ["AKIAIOSFODNN7EXAMPLE", "sk-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "postgres://admin:hunter22@db/x", "password=hunter22", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"]) {
      expect(redactValuePatterns(secret).redacted, secret).toBe(true);
    }
  });

  it("leaves ordinary values alone", () => {
    for (const plain of ["12.0", "[1, 2, 3]", "{'name': 'pen', 'qty': 4}", "https://example.com/a/b", "Bearer"]) {
      expect(redactValuePatterns(plain).redacted, plain).toBe(false);
    }
  });

  it("does not treat counts and sizes of tokens as credentials", () => {
    for (const name of ["token_count", "max_tokens", "numTokens", "tokenLimit", "total_tokens", "token_type", "token_expires_at"]) {
      expect(isSecretName(name), name).toBe(false);
    }
    for (const name of ["token", "auth_token", "accessToken", "api_key", "password", "client_secret"]) {
      expect(isSecretName(name), name).toBe(true);
    }
    expect(expressionMentionsSecret("token_count + 1")).toBe(false);
  });

  it("applies name first, then value shapes", () => {
    expect(redactVariable("api_key", "anything")).toEqual({ value: "[REDACTED]", redacted: true });
    expect(redactVariable("payload", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc").redacted).toBe(true);
    expect(redactVariable("token_count", "412")).toEqual({ value: "412", redacted: false });
  });
});

describe("redactSourceLine", () => {
  it("replaces a literal assigned to a credential-looking name", () => {
    expect(redactSourceLine('api_key = "demo-not-a-real-key"')).toBe("api_key = [REDACTED]");
    expect(redactSourceLine("password = 'hunter2'")).toBe("password = [REDACTED]");
  });
  it("keeps ordinary code, including comparisons", () => {
    expect(redactSourceLine("total = sum(prices)")).toBe("total = sum(prices)");
    expect(redactSourceLine("if token == expected:")).toBe("if token == expected:");
  });
});
