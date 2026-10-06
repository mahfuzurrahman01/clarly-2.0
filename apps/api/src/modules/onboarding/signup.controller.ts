// Product shell (OnboardingModule, Feature 6): "Tenant provisioning" —
// the one endpoint in this app that must NOT sit behind
// TenantAuthMiddleware, since the whole point is that the caller doesn't
// have a tenant yet. Guarded by FreshSignupAuthGuard instead (signature +
// expiry + `sub` only — see that guard's own header comment).
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { CurrentFreshSignupAuth } from '../auth/current-fresh-signup-auth.decorator';
import { FreshSignupAuthGuard } from '../auth/fresh-signup-auth.guard';
import type { FreshSignupAuthContext } from '../auth/jwt-claims';
import { signupBodySchema, SignupBodyDto } from './signup.dto.zod';
import {
  TenantProvisioningResultDto,
  type TenantProvisioningResult,
} from './tenant-provisioning.dto';
import { TenantProvisioningService } from './tenant-provisioning.service';

@ApiTags('onboarding')
@ApiBearerAuth()
@Controller('onboarding/signup')
@UseGuards(FreshSignupAuthGuard)
export class SignupController {
  constructor(private readonly provisioning: TenantProvisioningService) {}

  @Post()
  @ApiOperation({
    summary: 'Provision a tenant for the signed-up user',
    description:
      'The only endpoint that accepts a token with **no tenant claim** — that is the point, the caller does not have a tenant yet. It is validated for signature, expiry, and `sub` only, not for `tenant_id`/`app_role`. Call this immediately after a Supabase sign-up, with that fresh session token as the bearer.\n\nThe caller becomes admin of the new tenant. `claimsAssigned: false` means the tenant exists but the Supabase claims write did not happen (no-op provider) — the user must refresh their session out-of-band before any other route will accept their token.',
  })
  @ApiCreatedResponse({ type: TenantProvisioningResultDto })
  @ApiValidationErrorResponse()
  @ApiUnauthorizedResponse()
  signUp(
    @CurrentFreshSignupAuth() auth: FreshSignupAuthContext,
    @Body(new ZodValidationPipe(signupBodySchema)) body: SignupBodyDto,
  ): Promise<TenantProvisioningResult> {
    return this.provisioning.signUp(
      auth.userId,
      body.tenantName,
      auth.existingTenantId,
    );
  }
}
