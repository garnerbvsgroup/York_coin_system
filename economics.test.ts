import Decimal from 'decimal.js';
import {
  EconomicState,
  getCurrentValue,
  applyBuy,
  applyAdminGrant,
  applyBurn,
  applyStorePurchaseBurn,
  applyStorePurchaseRecycle,
  applyRedeem,
  checkConservation,
} from '../economics';

function genesisState(): EconomicState {
  return {
    maxSupplyCap: new Decimal(1_000_000),
    circulatingSupply: new Decimal(0),
    availablePool: new Decimal(1_000_000),
    destroyedTotal: new Decimal(0),
    reserveAmount: new Decimal(0),
    genesisPrice: new Decimal('0.01'),
    lastKnownValue: null,
  };
}

describe('York Coin economics', () => {
  test('Phase 0 — true genesis value is undefined-in-spirit but resolves to genesis price on first use', () => {
    const state = genesisState();
    // Per spec: 0÷0 is conceptually undefined, but the genesis price bootstraps it.
    expect(getCurrentValue(state).toString()).toBe('0.01');
  });

  test('Event 1 — first buy establishes reserve/circulating exactly at genesis price', () => {
    const state = genesisState();
    const { state: s1, priceUsed, dollarAmount } = applyBuy(state, new Decimal(50_000));
    expect(priceUsed!.toString()).toBe('0.01');
    expect(dollarAmount!.toString()).toBe('500');
    expect(s1.reserveAmount.toString()).toBe('500');
    expect(s1.circulatingSupply.toString()).toBe('50000');
    expect(s1.availablePool.toString()).toBe('950000');
    expect(getCurrentValue(s1).toString()).toBe('0.01');
    expect(checkConservation(s1)).toBe(true);
  });

  test('Events 2-3 — subsequent buys are value-neutral', () => {
    let state = genesisState();
    state = applyBuy(state, new Decimal(50_000)).state;
    state = applyBuy(state, new Decimal(20_000)).state;
    expect(getCurrentValue(state).toString()).toBe('0.01');
    state = applyBuy(state, new Decimal(10_000)).state;
    expect(getCurrentValue(state).toString()).toBe('0.01');
    expect(checkConservation(state)).toBe(true);
  });

  test('Event 4 — admin grant never dilutes value (reserve-backed)', () => {
    let state = genesisState();
    state = applyBuy(state, new Decimal(80_000)).state; // reserve=800, circulating=80000
    const priceBefore = getCurrentValue(state);
    const { state: afterGrant } = applyAdminGrant(state, new Decimal(5_000));
    expect(getCurrentValue(afterGrant).toString()).toBe(priceBefore.toString());
    expect(checkConservation(afterGrant)).toBe(true);
  });

  test('Event 6 — voluntary burn increases value for everyone, matches hand-calculated Sim 1.0 numbers', () => {
    let state = genesisState();
    state = applyBuy(state, new Decimal(80_000)).state; // reserve=800, circulating=80000
    state = applyAdminGrant(state, new Decimal(5_000)).state; // circulating=85000, reserve=850
    const { state: afterBurn } = applyBurn(state, new Decimal(5_000)); // circulating=80000
    // 850 / 80000 = 0.010625 — matches the validation report's hand-calculated result exactly.
    expect(getCurrentValue(afterBurn).toString()).toBe('0.010625');
    expect(checkConservation(afterBurn)).toBe(true);
  });

  test('Store recycle and store burn have IDENTICAL immediate value effect — they differ in where the removed coins go, not in immediate valuation', () => {
    // Both remove the coins from circulating supply, so both raise value by
    // the same amount immediately. The real difference: burned coins go to
    // destroyedTotal (gone forever); recycled coins go to availablePool
    // (resellable later, which can partially reverse the value increase
    // once someone actually buys them back).
    let recycleBranch = genesisState();
    recycleBranch = applyBuy(recycleBranch, new Decimal(80_000)).state;
    const priceBefore = getCurrentValue(recycleBranch);
    recycleBranch = applyStorePurchaseRecycle(recycleBranch, new Decimal(2_000)).state;

    let burnBranch = genesisState();
    burnBranch = applyBuy(burnBranch, new Decimal(80_000)).state;
    burnBranch = applyStorePurchaseBurn(burnBranch, new Decimal(2_000)).state;

    expect(getCurrentValue(recycleBranch).toString()).toBe(getCurrentValue(burnBranch).toString());
    expect(getCurrentValue(recycleBranch).greaterThan(priceBefore)).toBe(true);

    // But only the recycle branch has anything left in the available pool
    // for resale — the burn branch's coins are gone for good.
    expect(recycleBranch.availablePool.greaterThan(burnBranch.availablePool)).toBe(true);
    expect(burnBranch.destroyedTotal.greaterThan(recycleBranch.destroyedTotal)).toBe(true);

    expect(checkConservation(recycleBranch)).toBe(true);
    expect(checkConservation(burnBranch)).toBe(true);
  });

  test('Recycled coins re-enter circulation without incorrectly creating extra reserve', () => {
    let state = genesisState();
    state = applyBuy(state, new Decimal(80_000)).state; // reserve=800, circulating=80000
    state = applyStorePurchaseRecycle(state, new Decimal(2_000)).state; // available +2000, value unchanged
    const priceAfterRecycle = getCurrentValue(state);
    const { state: afterResale } = applyBuy(state, new Decimal(2_000)); // someone buys the recycled coins
    // Value must still equal the same price — no double-counted reserve.
    expect(getCurrentValue(afterResale).toString()).toBe(priceAfterRecycle.toString());
    expect(checkConservation(afterResale)).toBe(true);
  });

  test('Redemption is value-neutral (mirror of Buy), unlike Burn which is value-increasing', () => {
    let state = genesisState();
    state = applyBuy(state, new Decimal(80_000)).state;
    const priceBefore = getCurrentValue(state);
    const { state: afterRedeem } = applyRedeem(state, new Decimal(10_000));
    expect(getCurrentValue(afterRedeem).toString()).toBe(priceBefore.toString());
    expect(checkConservation(afterRedeem)).toBe(true);
  });

  test('CRITICAL scenario — redeeming all circulating supply returns to the exact genesis 0÷0 state, and next entrant continues at the frozen last known value (not reset to genesis price)', () => {
    let state = genesisState();
    state = applyBuy(state, new Decimal(80_000)).state; // circulating=80000, reserve=800, value=0.01
    const valueBeforeDrain = getCurrentValue(state);

    const { state: drained } = applyRedeem(state, new Decimal(80_000)); // redeem everything
    expect(drained.circulatingSupply.toString()).toBe('0');
    expect(drained.reserveAmount.toString()).toBe('0');
    // lastKnownValue must now be frozen at the pre-drain value, per the resolved re-genesis rule.
    expect(drained.lastKnownValue!.toString()).toBe(valueBeforeDrain.toString());
    expect(checkConservation(drained)).toBe(true);

    // Next entrant buys — must continue at the frozen value, not reset to 0.01.
    const { state: reGenesis, priceUsed } = applyBuy(drained, new Decimal(1_000));
    expect(priceUsed!.toString()).toBe(valueBeforeDrain.toString());
    expect(getCurrentValue(reGenesis).toString()).toBe(valueBeforeDrain.toString());
    expect(checkConservation(reGenesis)).toBe(true);
  });

  test('Buy request exceeding available pool queues instead of inventing a fallback', () => {
    const state = genesisState();
    const result = applyBuy(state, new Decimal(2_000_000)); // more than the entire cap
    expect(result.queued).toBe(true);
    expect(result.state).toEqual(state); // nothing changed — request just queues
  });

  test('Conservation invariant holds across a long mixed sequence (mini stress test)', () => {
    let state = genesisState();
    state = applyBuy(state, new Decimal(50_000)).state;
    state = applyBuy(state, new Decimal(20_000)).state;
    state = applyAdminGrant(state, new Decimal(5_000)).state;
    state = applyBurn(state, new Decimal(5_000)).state;
    state = applyStorePurchaseRecycle(state, new Decimal(2_000)).state;
    state = applyBuy(state, new Decimal(2_000)).state;
    state = applyStorePurchaseBurn(state, new Decimal(1_000)).state;
    state = applyRedeem(state, new Decimal(10_000)).state;

    expect(checkConservation(state)).toBe(true);
    // Sanity: nothing should ever go negative.
    expect(state.circulatingSupply.greaterThanOrEqualTo(0)).toBe(true);
    expect(state.availablePool.greaterThanOrEqualTo(0)).toBe(true);
    expect(state.reserveAmount.greaterThanOrEqualTo(0)).toBe(true);
  });
});
