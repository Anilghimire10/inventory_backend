/**
 * The counter a new store opens with, as a nested create on the store. Every
 * store needs one: a cashier is assigned to a counter before they can sell,
 * and an owner's till opens on one. More are added in Settings → Stores.
 * One helper for every path that creates a store, so none of them forgets.
 */
export const firstCounter = (businessId: string) => ({
  create: { businessId, name: 'Counter 1' },
});
