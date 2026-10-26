import { query, type Row } from "../db/connection";

export type Book = {
  isbn: string;
  title: string;
  priceCents: number;
  stock: number;
};

function toBook(row: Row): Book {
  return {
    isbn: String(row.isbn),
    title: String(row.title),
    priceCents: Number(row.priceCents),
    stock: Number(row.stock),
  };
}

export function listBooks(): Book[] {
  return query("books").map(toBook);
}

export function findBook(isbn: string): Book | undefined {
  const [row] = query("books", (candidate) => candidate.isbn === isbn);
  return row === undefined ? undefined : toBook(row);
}
