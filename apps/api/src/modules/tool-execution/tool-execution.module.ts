import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CourierModule } from '../courier/courier.module';
import { OrderModule } from '../order/order.module';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';
import { ToolExecutionService } from './tool-execution.service';

// Agent (AI-owned): the security boundary — authorize(ctx, name, args) then execute, emits ToolScopeViolation (T2/A2). Enforced rule 1: must not import AgentModule or PromptModule — enforcement path has zero dependency on the prompt path.
@Module({
  imports: [
    ToolRegistryModule,
    CatalogModule,
    OrderModule,
    CourierModule,
    BookingModule,
  ],
  controllers: [],
  providers: [ToolExecutionService],
  exports: [ToolExecutionService],
})
export class ToolExecutionModule {}
