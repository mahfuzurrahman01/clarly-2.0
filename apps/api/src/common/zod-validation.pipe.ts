// Shared: a generic Nest `PipeTransform` around a Zod schema. First real
// HTTP-boundary validation pipe in the app (KanbanModule, Feature 5) — one
// shared implementation rather than each controller hand-rolling its own
// `schema.safeParse()` + throw, per CLAUDE.md's DRY principle. Kept Zod
// (already the app's schema-validation library — env.schema.ts,
// jwt-claims.ts) rather than pulling in class-validator as a second one.
import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

// `TInput` is inferred from the schema rather than pinned to the output
// type: a schema with `.default()`/`.coerce`/`.transform()` (any query
// schema, in practice) parses an input shape that differs from what it
// produces, and defaulting `ZodType`'s input parameter to the output would
// reject exactly those schemas.
export class ZodValidationPipe<
  TOutput,
  TInput = unknown,
> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput, ZodTypeDef, TInput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }
    return result.data;
  }
}
