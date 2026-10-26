import { findBook } from "../catalog/bookRepository";
import { applyCoupon } from "../pricing/couponRules";
import { priceCart, type PricedCart, type PricedLine } from "../pricing/priceCalculator";

export type CartItem = {
  isbn: string;
  quantity: number;
};

export type CheckoutResult =
  | { ok: true; cart: PricedCart }
  | { ok: false; error: string };

export function checkout(items: CartItem[], couponCode?: string): CheckoutResult {
  const lines: PricedLine[] = [];

  for (const item of items) {
    const book = findBook(item.isbn);
    if (book === undefined) return { ok: false, error: `unknown book ${item.isbn}` };
    if (book.stock < item.quantity) return { ok: false, error: `not enough stock for ${book.title}` };
    lines.push({ isbn: book.isbn, quantity: item.quantity, unitCents: book.priceCents });
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
  return { ok: true, cart: priceCart(lines, applyCoupon(couponCode, subtotalCents)) };
}
