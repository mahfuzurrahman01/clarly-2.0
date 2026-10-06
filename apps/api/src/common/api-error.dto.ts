// Shared: the error envelope every route in this app returns, plus the
// composed `@ApiResponse` decorators that document it. Nest's built-in
// HttpException filter serializes to `{ statusCode, message, error }` —
// documenting that shape once here keeps the 19 operations from each
// hand-rolling the same five `@ApiResponse` blocks (CLAUDE.md's DRY
// principle), and gives the frontend one error type to code-generate
// against.
//
// Note on `createZodDto` usage across this app: the DTO class itself is passed
// to `@ApiOkResponse({ type: ... })`, never `Dto.Output`. That accessor exists
// only for zod v4 schemas, and this codebase is on zod 3.25 — nestjs-zod falls
// back to its v3 conversion path, which emits a single schema per DTO with no
// input/output split, so there is nothing to disambiguate.
import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** One entry from Zod's `error.issues`, which `ZodValidationPipe` passes straight through as the 400 body's `message`. */
const validationIssueSchema = z.object({
  code: z.string().describe('Zod issue code, e.g. `invalid_type`.'),
  path: z
    .array(z.union([z.string(), z.number()]))
    .describe('Path to the offending field. Numbers index into arrays.'),
  message: z.string(),
});

export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  message: z
    .union([z.string(), z.array(validationIssueSchema)])
    .describe(
      'A single string for most exceptions. On a 400 it is the Zod issue array instead, one entry per invalid field.',
    ),
  error: z
    .string()
    .optional()
    .describe('The HTTP status text, e.g. `Bad Request`.'),
});

export class ApiErrorDto extends createZodDto(apiErrorSchema) {}

/** 400 — request body/query failed its Zod schema. `message` carries the raw Zod issues. */
export const ApiValidationErrorResponse = (): ClassDecorator &
  MethodDecorator =>
  ApiResponse({
    status: 400,
    description:
      'Validation failed. `message` contains the Zod issue array describing each invalid field.',
    type: ApiErrorDto,
  });

/** 401 — missing/expired/invalid bearer token, or a token with no tenant claims. Applies to every route behind TenantAuthMiddleware. */
export const ApiUnauthorizedResponse = (): ClassDecorator & MethodDecorator =>
  ApiResponse({
    status: 401,
    description:
      'Missing, malformed, or expired bearer token — or a token carrying no tenant claim.',
    type: ApiErrorDto,
  });

/** 403 — authenticated, but the token's app_role is not `admin`. Only on RolesGuard-protected routes. */
export const ApiForbiddenResponse = (): ClassDecorator & MethodDecorator =>
  ApiResponse({
    status: 403,
    description:
      "Authenticated, but the caller's `app_role` is not `admin`. Agent-role tokens get this on every admin-gated route.",
    type: ApiErrorDto,
  });

/** The 401 + 403 pair every admin-gated route shares. */
export const ApiAdminOnlyResponses = (): ClassDecorator & MethodDecorator =>
  applyDecorators(ApiUnauthorizedResponse(), ApiForbiddenResponse());
