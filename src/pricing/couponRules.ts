export function applyCoupon(code: string | undefined, subtotalCents: number): number {
  switch (code?.toUpperCase()) {
    case "SUMMER10":
      return Math.round(subtotalCents * 0.1);
    case "WELCOME5":
      return Math.min(500, subtotalCents);
    default:
      return 0;
  }
}
