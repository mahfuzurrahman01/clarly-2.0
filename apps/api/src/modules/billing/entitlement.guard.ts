// BillingModule (Feature 8, T19): "plan-gating on tenant-scoped
// endpoints". Distinct from T17's usage/spend-cap enforcement
// (UsageService.checkEntitlement(), in RespondPathProcessor): this guard
// gates on *payment status*, not usage.
//
// A tenant WITH a subscription row is judged by evaluateEntitlementGate() —
// the exact rule the respond-path worker uses (comped, active, or a trial
// whose trial_ends_at is still ahead), so the console and the AI pipeline
// never disagree about a tenant that has billing state.
//
// A tenant with NO subscription row is deliberately still allowed here:
// that only happens where billing isn't set up (BILLING_PROVIDER=none, no
// plans seeded, so signup's local trial row is skipped). The worker still
// withholds AI replies for such a tenant; the console stays usable.
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { BillingService } from './billing.service';
import { evaluateEntitlementGate } from './usage.service';

@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(private readonly billing: BillingService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;

    if (!auth?.tenantId) {
      // No tenant on the request at all — not this guard's job (fails
      // closed elsewhere, e.g. TenantAuthMiddleware/RolesGuard); let the
      // request through this check rather than mask that failure.
      return true;
    }

    const subscription = await this.billing.getForTenant(auth.tenantId);
    if (!subscription) {
      return true;
    }

    if (!evaluateEntitlementGate(subscription).allowed) {
      // Frontend contract (Lane A): the billing UI matches this 403 by the
      // substring "Subscription is not active" to show its own billing-
      // lapsed messaging instead of a generic error page. Keep that exact
      // wording — do not reword this message without updating the
      // frontend lane too.
      throw new ForbiddenException(
        'Subscription is not active — update billing to continue',
      );
    }

    return true;
  }
}
