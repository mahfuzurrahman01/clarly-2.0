// Auth (AuthModule): T14's route-level role gate. Applied per-controller
// or per-handler, e.g. `@Roles('admin')` on team-management/tenant-policy
// endpoints, `@Roles('admin', 'agent')` (or simply no decorator, if any
// authenticated human agent should reach it) on ticket endpoints. Paired
// with RolesGuard, which reads this metadata via Reflector.
import { SetMetadata } from '@nestjs/common';
import type { AppRole } from './jwt-claims';

export const ROLES_KEY = 'appRoles';

export const Roles = (...roles: AppRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
