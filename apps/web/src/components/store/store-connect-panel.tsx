"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  type StoreProviderName,
  type ConnectStoreInput,
  connectStore,
  isPlausibleSiteUrl,
  normalizeShopifyShop,
} from "@/lib/api/store";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { storeProviderLabel } from "./store-provider-badge";

const OAUTH_PROVIDERS: StoreProviderName[] = ["salla", "zid"];

/**
 * Connect flow for the four F24 providers. All four are "call connect,
 * redirect the whole page to the returned authorizeUrl" — there is no popup
 * here, unlike the Meta embedded-signup flow, because the provider's own
 * consent screen has to navigate away from the console.
 * Salla/Zid need nothing up front. Shopify's OAuth host is per shop
 * (`<name>.myshopify.com`) and WooCommerce is self-hosted, so both ask for
 * the merchant's address first; the server 400s without it.
 */
export function StoreConnectPanel() {
  const t = useTranslations();
  const [connectingProvider, setConnectingProvider] = useState<StoreProviderName | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [shopInput, setShopInput] = useState("");

  async function startOAuth(provider: StoreProviderName, input: ConnectStoreInput = {}) {
    if (connectingProvider) return;
    setConnectingProvider(provider);
    try {
      const result = await connectStore(provider, input);
      // Full-page navigation: the provider's consent screen (or, for
      // WooCommerce, the merchant's own site) has to take over the tab.
      window.location.assign(result.authorizeUrl);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.store.couldNotConnect));
      setConnectingProvider(null);
    }
  }

  const siteUrlValid = isPlausibleSiteUrl(siteUrl);
  const shop = normalizeShopifyShop(shopInput);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {OAUTH_PROVIDERS.map((provider) => (
          <Button
            key={provider}
            type="button"
            variant="outline"
            onClick={() => startOAuth(provider)}
            disabled={connectingProvider !== null}
            aria-busy={connectingProvider === provider}
          >
            {connectingProvider === provider ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {t.store.connectButtonTemplate.replace(
              "{provider}",
              storeProviderLabel(provider, t),
            )}
          </Button>
        ))}
      </div>

      <div className="space-y-2 rounded-lg border border-dashed border-border p-4">
        <Label htmlFor="shopify-shop">{t.store.shopifyShopLabel}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="shopify-shop"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t.store.shopifyShopPlaceholder}
            value={shopInput}
            onChange={(e) => setShopInput(e.target.value)}
            aria-invalid={shopInput.length > 0 && !shop}
            className="max-w-sm"
          />
          <Button
            type="button"
            onClick={() => shop && startOAuth("shopify", { shop })}
            disabled={!shop || connectingProvider !== null}
            aria-busy={connectingProvider === "shopify"}
          >
            {connectingProvider === "shopify" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {t.store.connectShopify}
          </Button>
        </div>
        {shopInput.length > 0 && !shop ? (
          <p className="text-xs text-destructive">{t.store.shopifyShopInvalid}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t.store.shopifyShopHint}</p>
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-dashed border-border p-4">
        <Label htmlFor="woocommerce-site-url">{t.store.siteUrlLabel}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="woocommerce-site-url"
            type="text"
            inputMode="url"
            placeholder={t.store.siteUrlPlaceholder}
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            aria-invalid={siteUrl.length > 0 && !siteUrlValid}
            className="max-w-sm"
          />
          <Button
            type="button"
            onClick={() => startOAuth("woocommerce", { siteUrl: siteUrl.trim() })}
            disabled={!siteUrlValid || connectingProvider !== null}
            aria-busy={connectingProvider === "woocommerce"}
          >
            {connectingProvider === "woocommerce" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {t.store.connectWoocommerce}
          </Button>
        </div>
        {siteUrl.length > 0 && !siteUrlValid ? (
          <p className="text-xs text-destructive">{t.store.siteUrlInvalid}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t.store.siteUrlHint}</p>
        )}
      </div>
    </div>
  );
}
