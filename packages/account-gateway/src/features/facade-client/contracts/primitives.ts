import { z } from "zod";

/** Shared wire primitives; feature schemas never import their own index. */
export const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const deadline = z.iso.datetime({ offset: true }).max(64);
