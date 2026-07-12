// Lazy Neon Postgres connection. Returns null when no database is configured,
// so every caller can treat the guide DB as strictly optional. The driver is
// imported dynamically so local tooling without the package still works.

let sqlPromise = null;

export function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  if (!sqlPromise) {
    sqlPromise = import("@neondatabase/serverless").then(m => m.neon(url));
  }
  return sqlPromise;
}
