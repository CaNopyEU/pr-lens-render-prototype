export type PricedLine = {
  isbn: string;
  quantity: number;
  unitCents: number;
};

export type PricedCart = {
  lines: PricedLine[];
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
};

const FREE_SHIPPING_FROM_CENTS = 3000;
const SHIPPING_CENTS = 399;

export function priceCart(lines: PricedLine[], reductionCents = 0): PricedCart {
  const subtotalCents = lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
  const shippingCents = subtotalCents >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_CENTS;
  const totalCents = Math.max(0, subtotalCents - reductionCents) + shippingCents;

  return { lines, subtotalCents, shippingCents, totalCents };
}
