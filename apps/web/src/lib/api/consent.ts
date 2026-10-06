import { browserApiFetch } from "./client";

export type OptOutSource = "customer_keyword" | "admin";

export type CustomerConsentRecord = {
  customerId: string;
  phone: string;
  optedOutAt: string | null;
  optOutSource: OptOutSource | null;
};

/** Admin-only. Null means we've never heard from this number. */
export function getConsent(phone: string) {
  return browserApiFetch<CustomerConsentRecord | null>(
    `/customers/consent?phone=${encodeURIComponent(phone)}`,
  );
}

export function setConsent(phone: string, optedOut: boolean) {
  return browserApiFetch<CustomerConsentRecord>("/customers/consent", {
    method: "PUT",
    json: { phone, optedOut },
  });
}
