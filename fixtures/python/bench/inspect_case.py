"""Benchmark fixture: inspection, answer size, secret redaction, hot loop, deep stack, output."""


def build_payload():
    big_list = list(range(10_000))
    big_text = "x" * 5_000
    nested = {"level1": {"level2": {"level3": {"level4": list(range(50))}}}}
    api_key = "sk-live-abcdefghijklmnop1234"
    stripe_api_key = "rk_live_0123456789abcdef"
    db_password = "hunter2"
    token_count = 42
    payload = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def456"
    auth_header = "Bearer abcdefghijklmnopqrstuvwxyz"
    note = "nothing secret here"
    marker = len(big_list)  # BP_PAYLOAD
    return marker


def hot_loop(n):
    total = 0
    for i in range(n):
        total += i % 7  # BP_LOOP
    return total


def deep(n):
    if n == 0:
        return 0  # BP_DEEP
    return deep(n - 1) + 1


def main():
    for i in range(3):
        print(f"progress {i}")
    build_payload()
    result = hot_loop(5000)
    print("loop result", result)
    print("depth", deep(40))


if __name__ == "__main__":
    main()
