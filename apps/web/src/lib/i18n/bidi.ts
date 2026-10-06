/**
 * Direction for a customer's display name. A saved name gets `auto` (Arabic
 * or Latin, the text decides). A bare phone number or channel id has no
 * strong characters, so `auto` would fall back to the page's RTL and put the
 * truncation ellipsis on the wrong end ("…316904"); it is always LTR.
 */
export function contactNameDir(customerName: string | null): "auto" | "ltr" {
  return customerName ? "auto" : "ltr";
}
