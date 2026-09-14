// Pure economic-state math — no Prisma, no NestJS, no I/O. This is the same
// logic economy.service.ts uses, extracted so it can be unit tested in
// complete isolation and so tests can never drift from what the API
// actually runs (the API's EconomyService should delegate to these
// functions rather than reimplementing the formulas inline).

import Decimal from 'decimal.js';

export interface EconomicState {
  maxSupplyCap: Decimal;
  circulatingSupply: Decimal;
  availablePool: Decimal;
  destroyedTotal: Decimal;
  reserveAmount: Decimal;
  genesisPrice: Decimal;
  lastKnownValue: Decimal | null;
}

export function getCurrentValue(state: EconomicState): Decimal {
  if (state.circulatingSupply.equals(0)) {
    if (state.lastKnownValue !== null) return state.lastKnownValue; // re-genesis
    return state.genesisPrice; // true genesis
  }
  return state.reserveAmount.div(state.circulatingSupply);
}

function freezeIfDrained(state: EconomicState, priceAtEvent: Decimal): EconomicState {
  if (state.circulatingSupply.equals(0)) {
    return { ...state, lastKnownValue: priceAtEvent };
  }
  return state;
}

export function applyBuy(state: EconomicState, ycAmount: Decimal) {
  if (state.availablePool.lessThan(ycAmount)) {
    return { state, queued: true as const };
  }
  const price = getCurrentValue(state);
  const dollarAmount = ycAmount.mul(price);
  const next: EconomicState = {
    ...state,
    reserveAmount: state.reserveAmount.add(dollarAmount),
    circulatingSupply: state.circulatingSupply.add(ycAmount),
    availablePool: state.availablePool.sub(ycAmount),
  };
  return { state: next, queued: false as const, priceUsed: price, dollarAmount };
}

export function applyAdminGrant(state: EconomicState, ycAmount: Decimal) {
  const price = getCurrentValue(state);
  const dollarValue = ycAmount.mul(price);
  const next: EconomicState = {
    ...state,
    reserveAmount: state.reserveAmount.add(dollarValue),
    circulatingSupply: state.circulatingSupply.add(ycAmount),
    availablePool: state.availablePool.sub(ycAmount),
  };
  return { state: next, priceUsed: price, dollarValue };
}

export function applyBurn(state: EconomicState, ycAmount: Decimal) {
  const priceBefore = getCurrentValue(state);
  let next: EconomicState = {
    ...state,
    circulatingSupply: state.circulatingSupply.sub(ycAmount),
    destroyedTotal: state.destroyedTotal.add(ycAmount),
  };
  next = freezeIfDrained(next, priceBefore);
  return { state: next };
}

export function applyStorePurchaseBurn(state: EconomicState, ycAmount: Decimal) {
  return applyBurn(state, ycAmount); // identical effect on global state
}

export function applyStorePurchaseRecycle(state: EconomicState, ycAmount: Decimal) {
  // Recycled coins leave circulation (the buyer no longer holds them) and
  // return to the unissued/available pool — both fields must change, or the
  // conservation law (cap = circulating + available + destroyed) breaks and
  // repeated recycle→resell cycles would silently mint value beyond the cap.
  const next: EconomicState = {
    ...state,
    circulatingSupply: state.circulatingSupply.sub(ycAmount),
    availablePool: state.availablePool.add(ycAmount),
  };
  return { state: next };
}

export function applyRedeem(state: EconomicState, ycAmount: Decimal) {
  const price = getCurrentValue(state);
  const dollarValue = ycAmount.mul(price);
  let next: EconomicState = {
    ...state,
    reserveAmount: state.reserveAmount.sub(dollarValue),
    circulatingSupply: state.circulatingSupply.sub(ycAmount),
    destroyedTotal: state.destroyedTotal.add(ycAmount),
  };
  next = freezeIfDrained(next, price);
  return { state: next, priceUsed: price, dollarValue };
}

/** Conservation invariant from the validation report:
 *  Max Cap = Circulating + Available + Destroyed */
export function checkConservation(state: EconomicState): boolean {
  const total = state.circulatingSupply.add(state.availablePool).add(state.destroyedTotal);
  return total.equals(state.maxSupplyCap);
}
