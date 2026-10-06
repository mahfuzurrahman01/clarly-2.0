import { SetMetadata } from '@nestjs/common';
import type { PlatformRole } from '../persistence/drizzle/schema';

export const PLATFORM_ROLES_KEY = 'platformRoles';

/**
 * Restricts a `/platform/*` handler to these operator roles. With no
 * decorator any operator (owner, staff or viewer) may call it, which is right
 * for reads and wrong for every write: writes must name their roles.
 */
export const PlatformRoles = (
  ...roles: PlatformRole[]
): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_ROLES_KEY, roles);
