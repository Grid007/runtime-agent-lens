"use strict";
// Fixture for exercising the debugger MCP with js-debug (parent + child sessions).

function applyDiscount(total, code) {
  const discounts = { SAVE10: 0.1, SAVE20: 0.2 };
  const rate = discounts[code] ?? 0;
  return total * (1 - rate);
}

function averageItemPrice(items) {
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const count = items.reduce((sum, item) => sum + item.qty, 0);
  return total / count; // NaN when the cart is empty
}

function main() {
  const apiToken = "tok-test-not-a-real-token";
  const carts = [
    [
      { name: "pen", price: 1.5, qty: 4 },
      { name: "pad", price: 3.0, qty: 2 },
    ],
    [],
  ];
  carts.forEach((cart, index) => {
    console.log(`cart ${index}: ${cart.length} items`);
    const avg = averageItemPrice(cart);
    console.log(`  average price ${avg.toFixed(2)}, discounted ${applyDiscount(avg, "SAVE10").toFixed(2)}`);
  });
  console.log("done", apiToken.slice(0, 3));
}

main();
