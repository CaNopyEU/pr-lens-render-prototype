export type Row = Record<string, string | number>;

const tables: Record<string, Row[]> = {
  books: [
    { isbn: "978-0141439518", title: "Pride and Prejudice", priceCents: 899, stock: 12 },
    { isbn: "978-0451524935", title: "Nineteen Eighty-Four", priceCents: 1099, stock: 4 },
    { isbn: "978-0060850524", title: "Brave New World", priceCents: 1299, stock: 0 },
  ],
};

export function query(table: string, where: (row: Row) => boolean = () => true): Row[] {
  return (tables[table] ?? []).filter(where);
}
