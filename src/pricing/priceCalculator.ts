import type { Discount } from "./discountCodes";

export type PricedLine = {
  isbn: string;
  quantity: number;
  unitCents: number;
};

export type PricedCart = {
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  discountCode?: string;
  shippingCents: number;
  totalCents: number;
};

const FREE_SHIPPING_FROM_CENTS = 3000;
const SHIPPING_CENTS = 399;

export function subtotalOf(lines: PricedLine[]): number {
  return lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
}

function reductionFor(discount: Discount | undefined, subtotalCents: number): number {
  if (discount === undefined) return 0;
  const cents = discount.kind === "percent" ? Math.round((subtotalCents * discount.percent) / 100) : discount.cents;
  return Math.min(cents, subtotalCents);
}

export function priceCart(lines: PricedLine[], discount?: Discount): PricedCart {
  const subtotalCents = subtotalOf(lines);
  const discountCents = reductionFor(discount, subtotalCents);
  const shippingCents = subtotalCents - discountCents >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_CENTS;
  const totalCents = subtotalCents - discountCents + shippingCents;

  return { lines, subtotalCents, discountCents, discountCode: discount?.code, shippingCents, totalCents };
}
