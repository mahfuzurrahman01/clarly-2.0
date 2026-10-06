// ObservabilityModule (T18): public, unauthenticated health-check
// endpoint for external synthetic uptime monitors — the "API uptime
// probe" condition T18 requires had no existing shortcut (unlike the
// other 4 platform-health checks), since no health endpoint existed
// anywhere in this codebase before this pass. Reuses the same two
// dependency pings PlatformHealthCheckService uses internally
// (PersistenceService.ping(), QueueHealthService.ping()) rather than a
// third connectivity-check mechanism.
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PersistenceService } from '../persistence/persistence.service';
import { QueueHealthService } from '../queue/queue-health.service';

export const healthCheckResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  dependencies: z.object({
    postgres: z.boolean(),
    redis: z.boolean(),
  }),
});

type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>;

export class HealthCheckResponseDto extends createZodDto(
  healthCheckResponseSchema,
) {}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly queueHealth: QueueHealthService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Liveness and dependency probe',
    description:
      'Public and unauthenticated — no bearer token needed, so this is the one route on this page you can call with nothing configured.\n\nPings Postgres and Redis. Returns 200 only when both are reachable; if either is down the same body comes back with a **503** status, because synthetic monitors key on the status code and a 200 "degraded" would silently pass them.',
  })
  @ApiResponse({
    status: 200,
    description: 'Both dependencies reachable.',
    type: HealthCheckResponseDto,
  })
  @ApiResponse({
    status: 503,
    description:
      'At least one dependency is unreachable. The body names which, under `dependencies`.',
    type: HealthCheckResponseDto,
  })
  async check(): Promise<HealthCheckResponse> {
    const [postgres, redis] = await Promise.all([
      this.persistence.ping().catch(() => false),
      this.queueHealth.ping().catch(() => false),
    ]);

    const response: HealthCheckResponse = {
      status: postgres && redis ? 'ok' : 'degraded',
      dependencies: { postgres, redis },
    };

    // Non-2xx on a dependency outage — synthetic monitors key on status
    // code, not response body, to flag "down." A 200 "degraded" body
    // would silently pass most uptime checks.
    if (response.status === 'degraded') {
      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}
