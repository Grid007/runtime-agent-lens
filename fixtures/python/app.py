"""Fixture for exercising the debugger MCP: a small order-pricing bug."""


def apply_discount(total, code):
    discounts = {"SAVE10": 0.10, "SAVE15": 0.15, "SAVE20": 0.20}
    rate = discounts.get(code, 0)
    return total * (1 - rate)


def average_item_price(items):
    total = sum(item["price"] * item["qty"] for item in items)
    count = sum(item["qty"] for item in items)
    if count == 0:
        return 0
    return total / count  # ZeroDivisionError when the cart is empty


def main():
    api_key = "demo-not-a-real-key"
    carts = [
        [{"name": "pen", "price": 1.5, "qty": 4}, {"name": "pad", "price": 3.0, "qty": 2}],
        [],
    ]
    for index, cart in enumerate(carts):
        print(f"cart {index}: {len(cart)} items")
        avg = average_item_price(cart)
        print(f"  average price {avg:.2f}, discounted {apply_discount(avg, 'SAVE10'):.2f}")
        print(f"  SAVE15 discounted {apply_discount(avg, 'SAVE15'):.2f}")
    print("done", api_key[:3])


if __name__ == "__main__":
    main()
