import { findBook } from "../catalog/bookRepository";
import { lookupDiscount } from "../pricing/discountCodes";
import { priceCart, subtotalOf, type PricedCart, type PricedLine } from "../pricing/priceCalculator";

export type CartItem = {
  isbn: string;
  quantity: number;
};

export type CheckoutResult =
  | { ok: true; cart: PricedCart }
  | { ok: false; error: string };

export function checkout(items: CartItem[], discountCode?: string, today = new Date().toISOString().slice(0, 10)): CheckoutResult {
  const lines: PricedLine[] = [];

  for (const item of items) {
    const book = findBook(item.isbn);
    if (book === undefined) return { ok: false, error: `unknown book ${item.isbn}` };
    if (book.stock < item.quantity) return { ok: false, error: `not enough stock for ${book.title}` };
    lines.push({ isbn: book.isbn, quantity: item.quantity, unitCents: book.priceCents });
  }

  if (discountCode === undefined) return { ok: true, cart: priceCart(lines) };

  const lookup = lookupDiscount(discountCode, subtotalOf(lines), today);
  if (!lookup.ok) return { ok: false, error: `discount code ${discountCode} is ${lookup.reason}` };

  return { ok: true, cart: priceCart(lines, lookup.discount) };
}
