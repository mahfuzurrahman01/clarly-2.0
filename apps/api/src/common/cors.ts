// CORS for the API. Two audiences:
//   - the web console: an explicit allow-list (CORS_ORIGINS), never a wildcard;
//   - Clarly 2.0 S3's public widget endpoints (`/widget/v1/*`), called from
//     tenants' own websites: any origin is REFLECTED here, and the widget
//     controller then refuses (403) every origin not on that widget's own
//     allow-list. Credentials are off for both: the console sends a bearer
//     token and the widget a signed visitor token, never cookies.
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';

export const WIDGET_PUBLIC_PREFIX = '/widget/v1/';

export function corsOptionsFor(
  url: string | undefined,
  consoleOrigins: readonly string[],
): CorsOptions {
  const isWidget = (url ?? '').startsWith(WIDGET_PUBLIC_PREFIX);
  if (isWidget) {
    return {
      origin: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      credentials: false,
      maxAge: 600,
    };
  }
  return {
    origin: consoleOrigins.length > 0 ? [...consoleOrigins] : false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
  };
}

export function buildCorsDelegate(
  consoleOrigins: readonly string[],
): CorsOptionsDelegate<{ url?: string }> {
  return (req, callback) =>
    callback(null, corsOptionsFor(req.url, consoleOrigins));
}
