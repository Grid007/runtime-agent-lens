"""Benchmark fixture: an uncaught exception three frames deep."""


def parse_qty(raw):
    return int(raw)


def line_total(line):
    return line["price"] * parse_qty(line["qty"])


def order_total(lines):
    return sum(line_total(line) for line in lines)


def main():
    orders = [
        [{"price": 2, "qty": "3"}],
        [{"price": 5, "qty": "two"}],
    ]
    for order in orders:
        print("order total", order_total(order))


if __name__ == "__main__":
    main()
