// Agent (AI-owned): the shape TenantToolRegistryService hands back —
// callers get this, never the raw Drizzle row, so a schema.ts column
// rename doesn't ripple into ToolExecutionModule/PromptModule call sites.
export interface TenantToolRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  jsonSchema: unknown;
  enabled: boolean;
}

/** What PromptModule (Feature 3) reads to build L3 — name/description/parameters, the common LLM tool-call shape. */
export interface PromptToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}
