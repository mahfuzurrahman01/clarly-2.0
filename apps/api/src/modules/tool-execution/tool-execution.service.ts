// Agent (AI-owned, T2): the security boundary. authorize(ctx, name,
// args) is the ONLY sanctioned way to check "may this tenant invoke this
// tool with these args" — the LLM's own claims about what it's allowed to
// call are never trusted; the tenant's own tenant_tools rows (RLS-scoped,
// Feature 1's T5) are the source of truth for scope, and TOOL_DEFINITIONS
// (this module) is the source of truth for arg shape.
//
// Two distinct failure modes, two distinct errors, both from
// packages/errors' T1 registry:
//   - ToolScopeViolation: the tool name itself is outside the tenant's
//     allowlist (not enabled for this tenant, or doesn't exist in code).
//   - LLMMalformedToolCall: the tool IS in scope but the args fail schema
//     validation.
// Neither error's message includes which check failed or why — see each
// class's own doc comment for why detail must not leak to the
// attacker-facing side of a prompt-injection attempt (A10).
//
// Enforced rule 1 (AI_PIPELINE_PLAN.md / eslint.module-boundaries.mjs):
// this module must not import AgentModule or PromptModule.
import { Injectable } from '@nestjs/common';
import { LLMMalformedToolCall, ToolScopeViolation } from '@repo/errors';
import type { z } from 'zod';
import { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import { CatalogProductExecutor } from '../catalog/catalog-product-executor';
import { LookupProductInput } from '../catalog/catalog-product.tool';
import { CreateOrderExecutor } from '../order/create-order-executor';
import { CreateOrderInput } from '../order/create-order.tool';
import { TrackOrderExecutor } from '../courier/track-order-executor';
import { TrackOrderInput } from '../courier/track-order.tool';
import {
  BookAppointmentExecutor,
  CheckAvailabilityExecutor,
} from '../booking/booking-tool-executors';
import {
  BookAppointmentInput,
  CheckAvailabilityInput,
} from '../booking/booking-tools';
import { TOOL_DEFINITIONS } from './tool-definitions';
import type { ToolExecutionContext } from './tool-execution-context';

@Injectable()
export class ToolExecutionService {
  constructor(
    private readonly toolRegistry: TenantToolRegistryService,
    private readonly catalogProductExecutor: CatalogProductExecutor,
    private readonly createOrderExecutor: CreateOrderExecutor,
    private readonly trackOrderExecutor: TrackOrderExecutor,
    private readonly checkAvailabilityExecutor: CheckAvailabilityExecutor,
    private readonly bookAppointmentExecutor: BookAppointmentExecutor,
  ) {}

  /**
   * Validates tenant scope + arg shape and returns the parsed (safe-to-use)
   * args. Does NOT execute the tool — actual side-effecting execution is a
   * Feature 3+ (AgentModule) concern once real tools exist; this module's
   * job ends at "these args are safe to pass to whatever executes next."
   *
   * Takes the whole `ToolExecutionContext` rather than a bare `tenantId` so
   * that authorize() and execute() are always handed the SAME turn identity
   * object — an authorization decision made for one turn must not be able to
   * be spent on another. Scope today is still decided by `ctx.tenantId`
   * alone; nothing below reads the turn-scoped fields.
   */
  async authorize(
    ctx: ToolExecutionContext,
    toolName: string,
    args: unknown,
  ): Promise<Record<string, unknown>> {
    const definition = TOOL_DEFINITIONS[toolName];

    // Checked in this order deliberately: a tool name with no in-code
    // definition is treated identically to "not enabled for this tenant" —
    // both surface as ToolScopeViolation, so an attacker probing tool names
    // can't distinguish "doesn't exist" from "exists but isn't yours."
    const isEnabled = definition
      ? await this.toolRegistry.isToolEnabledForTenant(ctx.tenantId, toolName)
      : false;

    if (!definition || !isEnabled) {
      throw new ToolScopeViolation();
    }

    const parsed = definition.zodSchema.safeParse(args);
    if (!parsed.success) {
      throw new LLMMalformedToolCall();
    }

    return parsed.data as Record<string, unknown>;
  }

  /**
   * Runs the tool's actual side-effecting logic against already-authorized
   * args (call authorize() first — this method does not re-check tenant
   * scope).
   *
   * `ctx` is a required parameter rather than something an executor reads
   * from ambient context: every real tool below queries tenant data (F20
   * `products`, F24 `store_connections`), and the tenant those reads are
   * scoped to must be the one the caller authorized, not whatever happens to
   * be on the async context at execution time. The same argument applies to
   * the turn-scoped fields (`conversationId`, `customerId`, `turnId`), which
   * is why they travel in the same object and never as tool ARGUMENTS: an
   * identity the model can fill is an identity a customer can talk the model
   * into filling with someone else's value.
   *
   * Executors that only need the tenant (`lookup_product`, `create_order`)
   * read `ctx.tenantId` and ignore the rest — unchanged behaviour.
   */
  async execute(
    ctx: ToolExecutionContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (toolName) {
      case 'echo':
        return { message: args.message };
      case 'lookup_product':
        return this.catalogProductExecutor.execute(
          ctx,
          this.narrow(LookupProductInput, args),
        );
      case 'create_order':
        return this.createOrderExecutor.execute(
          ctx,
          this.narrow(CreateOrderInput, args),
        );
      // F26 (D4): the ONE executor that reads a turn-scoped field. It is
      // handed `ctx` like every other and derives the asking customer from
      // it — never from an argument, because an identity the model can fill
      // is an identity a customer can talk it into filling with someone
      // else's value. A null `ctx.customerId` returns the no-shipment
      // payload, never an unscoped query.
      case 'track_order':
        return this.trackOrderExecutor.execute(
          ctx,
          this.narrow(TrackOrderInput, args),
        );
      // Clarly 2.0 S2. book_appointment is customer-scoped like track_order:
      // the customer comes from `ctx`, never from an argument.
      case 'check_availability':
        return this.checkAvailabilityExecutor.execute(
          ctx,
          this.narrow(CheckAvailabilityInput, args),
        );
      case 'book_appointment':
        return this.bookAppointmentExecutor.execute(
          ctx,
          this.narrow(BookAppointmentInput, args),
        );
      default:
        // authorize() already guarantees toolName is a known TOOL_DEFINITIONS
        // key by the time execute() is called — reaching here means a caller
        // skipped authorize(), which is a programming error, not a runtime
        // condition to handle gracefully.
        throw new Error(
          `ToolExecutionService.execute(): no execution implemented for tool "${toolName}"`,
        );
    }
  }

  /**
   * Turns authorize()'s `Record<string, unknown>` into the executor's input
   * type. This re-runs the tool's own schema rather than casting: a cast
   * would make the executors' typed parameters a promise this class can't
   * keep if a caller ever reaches execute() without authorize(), and that is
   * exactly the path where an attacker-shaped payload would arrive. The
   * parse is a no-op on the sanctioned path, where authorize() has already
   * validated the same schema.
   */
  private narrow<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      throw new LLMMalformedToolCall();
    }
    return parsed.data;
  }
}
