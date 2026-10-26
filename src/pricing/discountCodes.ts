export type Discount =
  | { kind: "percent"; code: string; percent: number }
  | { kind: "fixed"; code: string; cents: number };

type DiscountCode = Discount & {
  validFrom: string;
  validUntil: string;
  minimumCents: number;
};

const CODES: DiscountCode[] = [
  { kind: "percent", code: "SUMMER10", percent: 10, validFrom: "2026-06-01", validUntil: "2026-08-31", minimumCents: 0 },
  { kind: "fixed", code: "WELCOME5", cents: 500, validFrom: "2026-01-01", validUntil: "2026-12-31", minimumCents: 1500 },
  { kind: "percent", code: "BOOKCLUB15", percent: 15, validFrom: "2026-01-01", validUntil: "2027-01-01", minimumCents: 2000 },
];

export type DiscountLookup =
  | { ok: true; discount: Discount }
  | { ok: false; reason: "unknown" | "expired" | "below-minimum" };

export function lookupDiscount(code: string, subtotalCents: number, today: string): DiscountLookup {
  const found = CODES.find((candidate) => candidate.code === code.trim().toUpperCase());
  if (found === undefined) return { ok: false, reason: "unknown" };
  if (today < found.validFrom || today > found.validUntil) return { ok: false, reason: "expired" };
  if (subtotalCents < found.minimumCents) return { ok: false, reason: "below-minimum" };

  const { validFrom, validUntil, minimumCents, ...discount } = found;
  return { ok: true, discount };
}
