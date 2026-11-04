"""Benchmark fixture: loyalty points report with a data-dependent bug."""
import json
from pathlib import Path

MULTIPLIER = {"VIP": 3, "SPRING": 2}


def load_orders(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def normalise(order):
    return {
        "customer": order["customer"].strip().upper(),
        "amount": order["amount_cents"] / 100,
        "tier": order.get("tier"),
    }


def points_for(order):
    base = int(order["amount"])
    return base * MULTIPLIER.get(order["tier"], 1)


def report(orders):
    totals = {}
    for raw in orders:
        order = normalise(raw)
        totals[order["customer"]] = totals.get(order["customer"], 0) + points_for(order)
    return totals


def main():
    orders = load_orders(Path(__file__).with_name("orders.json"))
    totals = report(orders)
    for customer in sorted(totals):
        print(customer, totals[customer])


if __name__ == "__main__":
    main()
