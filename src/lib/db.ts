import { PrismaClient } from "@prisma/client";

/**
 * Next.js hot-reloads modules in dev, which would otherwise spawn a new
 * PrismaClient (and a new DB connection pool) on every edit. Caching it on
 * the global object survives hot-reloads in dev; in production each
 * serverless invocation gets its own module scope anyway, so this is a
 * no-op there — this is Prisma's own documented pattern for Next.js.
 */
const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
