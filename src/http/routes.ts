import { checkout, type CartItem } from "../checkout/checkoutService";
import { listBooks } from "../catalog/bookRepository";

export type HttpRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};

export type HttpResponse = {
  status: number;
  body: unknown;
};

type CheckoutBody = {
  items: CartItem[];
  code?: string;
};

export function handle(request: HttpRequest): HttpResponse {
  if (request.method === "GET" && request.path === "/books") {
    return { status: 200, body: listBooks() };
  }

  if (request.method === "POST" && request.path === "/checkout") {
    const { items, code } = request.body as CheckoutBody;
    const result = checkout(items, code);
    return result.ok ? { status: 200, body: result.cart } : { status: 422, body: { error: result.error } };
  }

  return { status: 404, body: { error: "not found" } };
}
