// F26 (Delivery Tracking): one place that maps a connection's `courier`
// string to its adapter (D2).
//
// The port is per-connection, not per-deployment: one deployment serves an
// Aramex merchant and an SMSA merchant at the same time, so there is no
// boot-time provider enum and no COURIER_PROVIDER env var. This is the same
// correction F24's wiring needed.
//
// An unknown courier resolves to the no-op adapter, which refuses credentials
// and refuses signatures — fail closed, never "pretend it worked".
import { Injectable } from '@nestjs/common';
import { AramexConnector } from './ports/aramex.connector';
import { JtConnector } from './ports/jt.connector';
import { NaqelConnector } from './ports/naqel.connector';
import { NoopCourierConnector } from './ports/noop-courier.connector';
import { SmsaConnector } from './ports/smsa.connector';
import type { CourierConnector } from './ports/courier-connector.port';

@Injectable()
export class CourierConnectorRegistry {
  private readonly connectors: ReadonlyMap<string, CourierConnector>;

  constructor(
    aramex: AramexConnector,
    smsa: SmsaConnector,
    naqel: NaqelConnector,
    jt: JtConnector,
    private readonly noop: NoopCourierConnector,
  ) {
    this.connectors = new Map<string, CourierConnector>([
      ['aramex', aramex],
      ['smsa', smsa],
      ['naqel', naqel],
      ['jt', jt],
    ]);
  }

  forCourier(courier: string): CourierConnector {
    return this.connectors.get(courier) ?? this.noop;
  }
}
