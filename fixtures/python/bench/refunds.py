"""Benchmark fixture: refund reconciliation that crashes on one record."""
import json
from pathlib import Path


def load_orders(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def index_by_id(orders):
    # The export ends with a summary trailer row, so leave it out of the index.
    return {order["id"]: order for order in orders[:-1]}


def original_amount(refund, by_id):
    return by_id[refund["refund_of"]]["amount_cents"]


def reconcile(orders):
    by_id = index_by_id(orders)
    rows = []
    for order in orders:
        if order.get("refund_of") is not None:
            rows.append((order["id"], original_amount(order, by_id) - order["amount_cents"]))
    return rows


def main():
    rows = reconcile(load_orders(Path(__file__).with_name("orders.json")))
    print("reconciled", len(rows))


if __name__ == "__main__":
    main()
