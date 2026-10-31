// Private contract parsing shared by HTTP facade and bearer validation.
import { KernelError } from "./domain.ts";

export interface Schema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: boolean; data?: T };
}
export function parse<T>(schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new KernelError("invalid");
  }
  return result.data as T;
}
