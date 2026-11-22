'use strict';
/*
 * Pizza City POS - sanity tests for order building.
 * Run:  node test.js   (or: npm test)
 * Uses the real database read-only; creates nothing.
 */
const assert = require('assert');
const { buildOrder, loadAll, getMenu, getSettings } = require('./server.js');

loadAll();
const menu = getMenu();
const settings = getSettings();

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}
const throws = (fn, re) => assert.throws(fn, re);

// pick a sized item with at least two priced sizes and an active single item
const sized = menu.items.find(i => i.type === 'sized' && i.active && i.prices.S > 0 && i.prices.M > 0);
const single = menu.items.find(i => i.type === 'single' && i.active && i.price > 0);
assert(sized && single, 'test needs at least one active sized and one active single item');

console.log('Pizza City POS tests\n');

ok('rejects empty order', () => throws(() => buildOrder({ items: [] }), /at least one item/));

ok('rejects unknown item', () =>
  throws(() => buildOrder({ items: [{ itemId: 'nope', size: 'M', qty: 1 }] }), /no longer exists/));

ok('rejects invalid size', () =>
  throws(() => buildOrder({ items: [{ itemId: sized.id, size: 'XXL', qty: 1 }] }), /valid size/));

ok('rejects zero quantity', () =>
  throws(() => buildOrder({ items: [{ itemId: sized.id, size: 'M', qty: 0 }] }), /Quantity/));

ok('rejects delivery without phone', () =>
  throws(() => buildOrder({ type: 'delivery', customerPhone: '123', items: [{ itemId: single.id, qty: 1 }] }), /Mobile number/));

ok('sized order math is exact', () => {
  const top = settings.toppingPrices.M || 0;
  const o = buildOrder({
    type: 'takeaway', paymentMethod: 'cash', cashReceived: '999999',
    items: [{ itemId: sized.id, size: 'M', qty: 2, toppings: 3 }]
  });
  const unit = sized.prices.M;
  assert.strictEqual(o.items[0].total, (unit + 3 * top) * 2);
  assert.strictEqual(o.subtotal, o.items[0].total);
  assert.strictEqual(o.total, o.subtotal + o.deliveryFee);
  assert.strictEqual(o.payment.change, o.payment.received - o.total);
  // not yet numbered - assignOrderNo does that after validation
  assert.strictEqual(o.no, 0);
  assert.strictEqual(o.id, '');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(o.date));
});

ok('discount is capped at subtotal', () => {
  const o = buildOrder({
    type: 'takeaway',
    items: [{ itemId: single.id, qty: 1 }],
    discount: { type: 'amount', value: 99999999 }
  });
  assert.strictEqual(o.discount.amount, o.subtotal);
  assert.strictEqual(o.total, 0);
});

ok('percent discount rounds correctly', () => {
  const o = buildOrder({
    type: 'takeaway',
    items: [{ itemId: single.id, qty: 3 }],
    discount: { type: 'percent', value: 10 }
  });
  assert.strictEqual(o.discount.amount, Math.round(o.subtotal * 10 / 100));
});

ok('delivery fee applies only to delivery', () => {
  const d = buildOrder({ type: 'delivery', customerPhone: '03001234567', items: [{ itemId: single.id, qty: 1 }], deliveryFee: '150' });
  assert.strictEqual(d.deliveryFee, 150);
  const t = buildOrder({ type: 'takeaway', items: [{ itemId: single.id, qty: 1 }], deliveryFee: '150' });
  assert.strictEqual(t.deliveryFee, 0);
});

ok('hidden item cannot be ordered', () => {
  const hidden = menu.items.find(i => !i.active);
  if (!hidden) return; // nothing hidden - skip
  throws(() => buildOrder({ items: [{ itemId: hidden.id, size: 'M', qty: 1 }] }), /switched off/);
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' (with failures)' : ''));
