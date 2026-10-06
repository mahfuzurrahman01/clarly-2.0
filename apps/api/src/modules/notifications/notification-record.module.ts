import { Module } from '@nestjs/common';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { NotificationService } from './notification.service';

export { NotificationService } from './notification.service';

// A NEAR-LEAF, for the same reason TenantAuthProvisioningModule is one, and
// it must stay that way: it imports TenantContextModule (-> PersistenceModule)
// and nothing else, so nothing it depends on can ever lead back up the graph.
//
// WHY IT EXISTS
// -------------
// `NotificationService` is the durable write half of alerting — "record that
// this happened so the tenant sees it in the bell menu". Four low-level
// modules do that: OrderModule, CourierModule, CampaignModule and
// BillingLifecycleModule. None of them wants anything else from
// `NotificationsModule`.
//
// But `NotificationsModule` is NOT low-level: it imports AlertingModule (it
// subscribes to the detectors), BillingModule (EntitlementGuard on its write
// routes) and EmailModule. So importing it just to record a notification was
// an edge from the bottom of the graph back to near the top — and in
// `2cf5d85` (Phase 7 / F25) the new `ToolExecutionModule -> OrderModule` edge
// turned that latent hazard into a real ring:
//
//   AlertingModule -> AgentConfigModule -> AgentModule -> ToolExecutionModule
//   -> OrderModule -> NotificationsModule -> AlertingModule
//
// No `forwardRef` anywhere on it, so Nest refused to build the container and
// the API would not start, while the build and all 3090 unit tests stayed
// green. This was the second of the two rings that commit closed; see
// `onboarding/ports/tenant-auth-provisioning.module.ts` for the first.
//
// `NotificationService` depends on nothing but `TenantContextService`, so the
// write half extracts cleanly. `NotificationsModule` imports this module and
// re-exports the service, so its own controller and subscriber — and any
// consumer that genuinely needs the rest of that module — are unaffected.
//
// Adding an import to this module would undo all of that. Don't.
// `src/module-graph.spec.ts` fails CI on any cycle lacking a `forwardRef`.
@Module({
  imports: [TenantContextModule],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationRecordModule {}
