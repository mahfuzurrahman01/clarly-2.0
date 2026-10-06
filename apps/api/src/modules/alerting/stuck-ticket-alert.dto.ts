/** T4: "Alert + dashboard signal when a ticket is unclaimed after N minutes (tenant-configurable, default 15)." */
export interface StuckTicketAlert {
  tenantId: string;
  ticketId: string;
  customerId: string;
  createdAt: Date;
  unclaimedMinutes: number;
  thresholdMinutes: number;
}
