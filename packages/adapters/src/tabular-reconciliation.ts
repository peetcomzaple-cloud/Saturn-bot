/**
 * Tabular and CSV reconciliation with deterministic validation.
 * Supports orders/refunds/rates multi-file reconciliation and single-file aggregations.
 */

export interface OrdersReconciliationResult {
  input_rows: number;
  unique_orders: number;
  duplicate_rows: number;
  cancelled_orders: number;
  paid_orders: number;
  gross_thb: number;
  refund_thb: number;
  net_thb: number;
  orphan_refunds: number;
}

export interface SingleFileAggregationResult {
  row_count: number;
  total_amount: number;
  last_id: string;
  last_amount: number;
}

export type TabularReconciliationResult =
  | { kind: "reconciliation"; data: OrdersReconciliationResult }
  | { kind: "aggregation"; data: SingleFileAggregationResult };

export class TruncatedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedDataError";
  }
}

/**
 * Robust CSV row parser that handles quoted cells, commas inside quotes, and CRLF/LF.
 */
export function parseCsvRows(content: string): Array<Record<string, string>> {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmptyLines = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (nonEmptyLines.length === 0) return [];

  const headers = parseCsvLine(nonEmptyLines[0]!);
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < nonEmptyLines.length; i++) {
    const values = parseCsvLine(nonEmptyLines[i]!);
    const record: Record<string, string> = {};
    for (let h = 0; h < headers.length; h++) {
      const headerName = headers[h]!;
      record[headerName] = values[h] ?? "";
    }
    rows.push(record);
  }

  return rows;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Case-insensitive, whitespace-trimmed field value lookup across candidate header names.
 */
export function getRowField(row: Record<string, string>, ...candidateNames: string[]): string {
  for (const name of candidateNames) {
    if (row[name] !== undefined) return row[name].trim();
    const lowerName = name.toLowerCase();
    for (const [k, v] of Object.entries(row)) {
      if (k.trim().toLowerCase() === lowerName) {
        return v.trim();
      }
    }
  }
  return "";
}

/**
 * Check whether CSV text contains truncation markers.
 */
export function isCsvTruncated(content: string): boolean {
  return (
    content.includes("[truncated]") ||
    content.includes("... (truncated)") ||
    content.includes("Showing lines 1 to")
  );
}

/**
 * Validate reconciliation mathematical and business invariants.
 */
export function validateReconciliationInvariants(
  res: OrdersReconciliationResult,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (res.input_rows !== res.unique_orders + res.duplicate_rows) {
    errors.push(
      `Invariant violation: input_rows (${res.input_rows}) != unique_orders (${res.unique_orders}) + duplicate_rows (${res.duplicate_rows})`,
    );
  }

  if (res.unique_orders < res.paid_orders + res.cancelled_orders) {
    errors.push(
      `Invariant violation: unique_orders (${res.unique_orders}) < paid_orders (${res.paid_orders}) + cancelled_orders (${res.cancelled_orders})`,
    );
  }

  if (res.net_thb !== res.gross_thb - res.refund_thb) {
    errors.push(
      `Invariant violation: net_thb (${res.net_thb}) != gross_thb (${res.gross_thb}) - refund_thb (${res.refund_thb})`,
    );
  }

  if (res.gross_thb < 0 || res.refund_thb < 0 || res.orphan_refunds < 0) {
    errors.push("Invariant violation: monetary totals and orphan count must be non-negative");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Reconcile orders.csv, refunds.csv, and rates.csv deterministically.
 */
export function reconcileOrdersRefundsRates(
  ordersContent: string,
  refundsContent: string,
  ratesContent: string,
  options?: { isTruncated?: boolean },
): OrdersReconciliationResult {
  if (
    options?.isTruncated ||
    isCsvTruncated(ordersContent) ||
    isCsvTruncated(refundsContent) ||
    isCsvTruncated(ratesContent)
  ) {
    throw new TruncatedDataError("Cannot reconcile truncated CSV content; complete file is required");
  }

  const orderRows = parseCsvRows(ordersContent);
  const refundRows = parseCsvRows(refundsContent);
  const rateRows = parseCsvRows(ratesContent);

  if (orderRows.length === 0) {
    throw new Error("orders.csv is empty or missing headers");
  }

  // 1. Validate rates header and map
  const ratesMap: Record<string, number> = {};
  for (const row of rateRows) {
    const currency = getRowField(row, "currency", "curr", "code").toUpperCase();
    if (!currency) continue;
    const rateStr = getRowField(row, "thb_per_unit", "rate_to_thb", "rate", "thb_rate");
    const rate = Number(rateStr);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`invalid exchange rate for currency "${currency}": must be a positive number`);
    }
    ratesMap[currency] = rate;
  }

  if (Object.keys(ratesMap).length === 0) {
    throw new Error("rates.csv has no valid exchange rates");
  }

  // Ensure THB default rate is at least 1 if not explicitly given
  if (!ratesMap.THB) ratesMap.THB = 1;

  // 2. Process orders: first duplicate wins, count duplicates
  const seenIds = new Set<string>();
  const allOrdersMap = new Map<string, { id: string; amount: number; currency: string; status: string }>();
  const uniqueOrders: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
  }> = [];
  let duplicateRows = 0;

  for (const row of orderRows) {
    const id = getRowField(row, "id", "order_id", "orderId", "order_number");
    if (!id) throw new Error("orders row missing id column");

    if (seenIds.has(id)) {
      duplicateRows++;
      continue;
    }
    seenIds.add(id);

    const amountStr = getRowField(row, "amount", "price", "total");
    const amount = Number(amountStr);
    if (!Number.isFinite(amount)) {
      throw new Error(`invalid amount "${amountStr}" for order id ${id}`);
    }

    const currency = getRowField(row, "currency", "curr").toUpperCase();
    if (!currency) {
      throw new Error(`missing currency for order id ${id}`);
    }
    if (!ratesMap[currency]) {
      throw new Error(`unknown currency "${currency}" in order ${id}; not found in rates.csv`);
    }

    const status = getRowField(row, "status", "order_status").toLowerCase();
    const orderRecord = { id, amount, currency, status };
    allOrdersMap.set(id, orderRecord);
    uniqueOrders.push(orderRecord);
  }

  // 3. Filter cancelled and paid orders
  const paidOrdersMap = new Map<string, { id: string; amount: number; currency: string }>();
  let cancelledOrders = 0;

  for (const order of uniqueOrders) {
    if (order.status === "cancelled") {
      cancelledOrders++;
    } else if (order.status === "paid") {
      paidOrdersMap.set(order.id, order);
    }
  }

  const paidOrders = Array.from(paidOrdersMap.values());

  // 4. Calculate gross_thb
  let grossThb = 0;
  for (const order of paidOrders) {
    const rate = ratesMap[order.currency];
    if (rate === undefined || rate <= 0) {
      throw new Error(`unknown rate for currency "${order.currency}" in paid order ${order.id}`);
    }
    grossThb += Math.round(order.amount * rate);
  }

  // 5. Process refunds
  let refundThb = 0;
  let orphanRefunds = 0;

  for (const row of refundRows) {
    const orderId = getRowField(row, "order_id", "orderId", "order_number", "id");
    const amountStr = getRowField(row, "amount", "refund_amount");
    const amount = Number(amountStr);
    const currency = getRowField(row, "currency", "curr").toUpperCase();

    // Look for matching paid order
    const matchingOrder = paidOrdersMap.get(orderId);
    if (!matchingOrder) {
      // If order not found in unique orders at all, count as orphan refund
      if (!allOrdersMap.has(orderId)) {
        orphanRefunds++;
      }
      // Cancelled orders and orphan orders are excluded from refund deduction
      continue;
    }

    // Currency must match original paid order
    if (matchingOrder.currency !== currency) {
      // Currency mismatch does not qualify for deduction
      continue;
    }

    const rate = ratesMap[currency];
    if (rate === undefined || rate <= 0) {
      throw new Error(`unknown rate for refund currency "${currency}"`);
    }

    refundThb += Math.round(amount * rate);
  }

  const netThb = grossThb - refundThb;

  const result: OrdersReconciliationResult = {
    input_rows: orderRows.length,
    unique_orders: uniqueOrders.length,
    duplicate_rows: duplicateRows,
    cancelled_orders: cancelledOrders,
    paid_orders: paidOrders.length,
    gross_thb: grossThb,
    refund_thb: refundThb,
    net_thb: netThb,
    orphan_refunds: orphanRefunds,
  };

  const validation = validateReconciliationInvariants(result);
  if (!validation.ok) {
    throw new Error(`Reconciliation invariant failure: ${validation.errors.join("; ")}`);
  }

  return result;
}

/**
 * Single-file tabular aggregation (e.g. large.csv, randomized.csv).
 */
export function aggregateSingleCsv(
  content: string,
  options?: { isTruncated?: boolean },
): SingleFileAggregationResult {
  if (options?.isTruncated || isCsvTruncated(content)) {
    throw new TruncatedDataError("Cannot aggregate truncated CSV data; complete file is required");
  }

  const rows = parseCsvRows(content);
  if (rows.length === 0) {
    throw new Error("CSV file is empty or missing headers");
  }

  let totalAmount = 0;
  for (const row of rows) {
    const amountStr = getRowField(row, "amount", "total", "value");
    const amount = Number(amountStr);
    if (Number.isFinite(amount)) {
      totalAmount += amount;
    }
  }

  const last = rows[rows.length - 1]!;
  const lastId = getRowField(last, "id", "item_id", "code");
  const lastAmountStr = getRowField(last, "amount", "total", "value");
  const lastAmount = Number(lastAmountStr);

  return {
    row_count: rows.length,
    total_amount: totalAmount,
    last_id: lastId,
    last_amount: Number.isFinite(lastAmount) ? lastAmount : 0,
  };
}

/**
 * Inspect a tabular CSV content and return matching metrics if applicable.
 */
export function inspectTabularContent(
  filename: string,
  content: string,
  options?: { isTruncated?: boolean },
): { aggregation?: SingleFileAggregationResult; note?: string } | undefined {
  if (!filename.toLowerCase().endsWith(".csv")) return undefined;

  try {
    const aggregation = aggregateSingleCsv(content, options);
    return { aggregation };
  } catch {
    return undefined;
  }
}
