import { describe, expect, it } from "vitest";
import {
  aggregateSingleCsv,
  parseCsvRows,
  reconcileOrdersRefundsRates,
  TruncatedDataError,
  validateReconciliationInvariants,
} from "./tabular-reconciliation.js";

describe("tabular reconciliation engine", () => {
  it("reconciles orders, refunds, and rates matching ground truth fixture exactly", () => {
    const rows = ["id,customer,amount,currency,status"];
    for (let i = 1; i <= 120; i++) {
      rows.push(`O${i},C${i % 7},${100 + i},${i % 4 === 0 ? "USD" : "THB"},${i % 11 === 0 ? "cancelled" : "paid"}`);
    }
    // Append 10 duplicate rows (O1 to O10)
    rows.push(...rows.slice(1, 11));

    const refunds = [
      "order_id,amount,currency",
      ...Array.from({ length: 10 }, (_, i) => `O${i + 1},30,${(i + 1) % 4 === 0 ? "USD" : "THB"}`),
      "MISSING,999,THB",
    ];

    const rates = "currency,thb_per_unit\nTHB,1\nUSD,35\n";

    const result = reconcileOrdersRefundsRates(
      rows.join("\n") + "\n",
      refunds.join("\n") + "\n",
      rates,
    );

    expect(result).toEqual({
      input_rows: 130,
      unique_orders: 120,
      duplicate_rows: 10,
      cancelled_orders: 10,
      paid_orders: 110,
      gross_thb: 171607,
      refund_thb: 2340,
      net_thb: 169267,
      orphan_refunds: 1,
    });

    const invariants = validateReconciliationInvariants(result);
    expect(invariants.ok).toBe(true);
    expect(invariants.errors).toHaveLength(0);
  });

  it("handles rates.csv with rate_to_thb header variant and case-insensitive headers", () => {
    const orders = "ID,Customer,Amount,Currency,Status\nO1,C1,100,THB,paid\nO2,C2,10,USD,paid\n";
    const refunds = "Order_Id,Amount,Currency\nO1,20,THB\n";
    const rates = "CURRENCY,RATE_TO_THB\nTHB,1\nUSD,35\n";

    const result = reconcileOrdersRefundsRates(orders, refunds, rates);
    expect(result).toEqual({
      input_rows: 2,
      unique_orders: 2,
      duplicate_rows: 0,
      cancelled_orders: 0,
      paid_orders: 2,
      gross_thb: 450, // 100 + 10*35
      refund_thb: 20,
      net_thb: 430,
      orphan_refunds: 0,
    });
  });

  it("does not deduct refund for cancelled order and does not count as orphan", () => {
    const orders = "id,customer,amount,currency,status\nO1,C1,100,THB,cancelled\nO2,C2,200,THB,paid\n";
    const refunds = "order_id,amount,currency\nO1,50,THB\n"; // O1 is cancelled!
    const rates = "currency,thb_per_unit\nTHB,1\n";

    const result = reconcileOrdersRefundsRates(orders, refunds, rates);
    expect(result.cancelled_orders).toBe(1);
    expect(result.paid_orders).toBe(1);
    expect(result.gross_thb).toBe(200);
    expect(result.refund_thb).toBe(0); // Cancelled order refund not deducted
    expect(result.orphan_refunds).toBe(0); // O1 was found in orders, so not orphan
    expect(result.net_thb).toBe(200);
  });

  it("ignores refund with currency mismatch without counting as orphan", () => {
    const orders = "id,customer,amount,currency,status\nO1,C1,100,THB,paid\n";
    const refunds = "order_id,amount,currency\nO1,50,USD\n"; // Mismatched currency!
    const rates = "currency,thb_per_unit\nTHB,1\nUSD,35\n";

    const result = reconcileOrdersRefundsRates(orders, refunds, rates);
    expect(result.gross_thb).toBe(100);
    expect(result.refund_thb).toBe(0);
    expect(result.orphan_refunds).toBe(0);
    expect(result.net_thb).toBe(100);
  });

  it("throws on unknown currency instead of silently using rate 0", () => {
    const orders = "id,customer,amount,currency,status\nO1,C1,100,EUR,paid\n";
    const refunds = "order_id,amount,currency\n";
    const rates = "currency,thb_per_unit\nTHB,1\nUSD,35\n";

    expect(() => reconcileOrdersRefundsRates(orders, refunds, rates)).toThrow(
      /unknown currency "EUR"/,
    );
  });

  it("throws on invalid non-positive rate", () => {
    const orders = "id,customer,amount,currency,status\nO1,C1,100,USD,paid\n";
    const refunds = "order_id,amount,currency\n";
    const rates = "currency,thb_per_unit\nTHB,1\nUSD,0\n";

    expect(() => reconcileOrdersRefundsRates(orders, refunds, rates)).toThrow(
      /invalid exchange rate/,
    );
  });

  it("throws TruncatedDataError when truncated option or marker is present", () => {
    const orders = "id,customer,amount,currency,status\nO1,C1,100,THB,paid\n[truncated]";
    const refunds = "order_id,amount,currency\n";
    const rates = "currency,thb_per_unit\nTHB,1\n";

    expect(() => reconcileOrdersRefundsRates(orders, refunds, rates)).toThrow(
      TruncatedDataError,
    );

    expect(() =>
      reconcileOrdersRefundsRates(
        "id,customer,amount,currency,status\nO1,C1,100,THB,paid\n",
        refunds,
        rates,
        { isTruncated: true },
      ),
    ).toThrow(TruncatedDataError);
  });

  it("validates mathematical invariants and reports discrepancies", () => {
    const invalidResult = {
      input_rows: 100,
      unique_orders: 80,
      duplicate_rows: 10, // 80 + 10 != 100
      cancelled_orders: 10,
      paid_orders: 70,
      gross_thb: 5000,
      refund_thb: 1000,
      net_thb: 3000, // 5000 - 1000 != 3000
      orphan_refunds: 0,
    };

    const inv = validateReconciliationInvariants(invalidResult);
    expect(inv.ok).toBe(false);
    expect(inv.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("aggregates single large CSV correctly", () => {
    const text =
      "id,amount\n" +
      Array.from({ length: 10000 }, (_, i) => `L${i + 1},${i + 1}`).join("\n") +
      "\n";
    const result = aggregateSingleCsv(text);
    expect(result).toEqual({
      row_count: 10000,
      total_amount: 50005000,
      last_id: "L10000",
      last_amount: 10000,
    });
  });

  it("aggregates randomized dataset fixture accurately", () => {
    const rows = ["id,amount"];
    let sum = 0;
    for (let i = 1; i <= 10000; i++) {
      const amt = (i * 37) % 10000;
      rows.push(`Q${i},${amt}`);
      sum += amt;
    }
    const result = aggregateSingleCsv(rows.join("\n") + "\n");
    expect(result.row_count).toBe(10000);
    expect(result.total_amount).toBe(sum);
    expect(result.last_id).toBe("Q10000");
    expect(result.last_amount).toBe((10000 * 37) % 10000);
  });

  it("throws TruncatedDataError when aggregating truncated content", () => {
    const text = "id,amount\nL1,10\n... (truncated)";
    expect(() => aggregateSingleCsv(text)).toThrow(TruncatedDataError);
  });

  it("parses CSV rows with quotes correctly", () => {
    const csv = 'id,name,amount\n1,"Item, with comma",50\n2,"Normal",20\n';
    const rows = parseCsvRows(csv);
    expect(rows).toEqual([
      { id: "1", name: "Item, with comma", amount: "50" },
      { id: "2", name: "Normal", amount: "20" },
    ]);
  });
});
