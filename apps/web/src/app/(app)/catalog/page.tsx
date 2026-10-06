import { getConsoleSession } from "@/lib/session";
import { listProducts, PRODUCTS_PAGE_SIZE } from "@/lib/api/catalog";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { CatalogManager } from "@/components/catalog/catalog-manager";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  const initial = await listProducts(
    { limit: PRODUCTS_PAGE_SIZE, offset: 0 },
    session.token,
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.catalog.eyebrow}
        title={t.catalog.title}
        description={t.catalog.description}
      />
      <div className="mt-8">
        <CatalogManager initial={initial} />
      </div>
    </div>
  );
}
