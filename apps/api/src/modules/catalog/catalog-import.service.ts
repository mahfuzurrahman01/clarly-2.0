// Feature 20 (Product Catalog & Stock): CSV import/export for products.
// Merchants with existing catalogs can bulk-upload via CSV.
//
// Two properties this file is responsible for, both learned the hard way:
//   - BOUNDED WORK PER REQUEST. This runs synchronously inside one HTTP
//     request. Before the cap, a 5k-row paste meant ~15k sequential
//     round-trips on one connection, holding a request open for minutes;
//     rows are now capped and written in batches, one statement per batch.
//   - NO SILENT COERCION. A row whose price does not parse is an ERROR, not
//     a 0.00 product. Importing a free product is worse than refusing the
//     row: the agent will happily quote it to a customer.
import { BadRequestException, Injectable } from '@nestjs/common';
import { CatalogService, type CreateProductInput } from './catalog.service';
import {
  CURRENCIES,
  STOCK_STATUSES,
} from '../persistence/drizzle/products.table';

export interface ImportResult {
  imported: number;
  updated: number;
  errors: Array<{ row: number; message: string }>;
}

/** Hard ceiling on one import request. Above this the merchant needs a real (async) job, not an HTTP round trip. */
export const MAX_IMPORT_ROWS = 1000;

/** Rows per INSERT ... ON CONFLICT statement. */
export const IMPORT_BATCH_SIZE = 100;

const EXPORT_LIMIT = 10_000;

interface ParsedRow {
  rowNumber: number;
  input: CreateProductInput;
}

@Injectable()
export class CatalogImportService {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Import products from a CSV string.
   * Format: name,name_ar,sku,price,currency,stock,category,description,description_ar,tags
   *
   * If sku matches an existing product for this tenant, it's updated
   * (a single atomic upsert — see CatalogService.upsertProductsDetailed).
   */
  async importCsv(tenantId: string, csv: string): Promise<ImportResult> {
    const lines = csv.split('\n').filter((line) => line.trim());
    if (lines.length < 2) {
      throw new BadRequestException(
        'CSV must have a header row and at least one data row',
      );
    }

    const dataRowCount = lines.length - 1;
    if (dataRowCount > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `CSV has ${dataRowCount} data rows; the maximum per import is ${MAX_IMPORT_ROWS}. Split the file and import it in parts.`,
      );
    }

    const headerMap = this.buildHeaderMap(this.parseCsvLine(lines[0]));
    const result: ImportResult = { imported: 0, updated: 0, errors: [] };
    const parsed: ParsedRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const rowNumber = i + 1;
      try {
        const input = this.mapRowToInput(
          headerMap,
          this.parseCsvLine(lines[i]),
        );
        parsed.push({ rowNumber, input });
      } catch (error) {
        result.errors.push({
          row: rowNumber,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Two rows with the same SKU in one batch would make the ON CONFLICT
    // statement "affect row a second time" (a Postgres error that would fail
    // the whole batch), so the later row wins — the same outcome as importing
    // them sequentially.
    const deduped = dedupeBySku(parsed);

    for (let i = 0; i < deduped.length; i += IMPORT_BATCH_SIZE) {
      const batch = deduped.slice(i, i + IMPORT_BATCH_SIZE);
      try {
        const upserts = await this.catalog.upsertProductsDetailed(
          tenantId,
          batch.map((row) => row.input),
        );
        for (const upsert of upserts) {
          if (upsert.created) result.imported++;
          else result.updated++;
        }
      } catch (error) {
        // A failed batch is reported per row rather than swallowed: the
        // merchant needs to know exactly which rows did not land.
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        for (const row of batch) {
          result.errors.push({ row: row.rowNumber, message });
        }
      }
    }

    return result;
  }

  /**
   * Export all products as a CSV string.
   */
  async exportCsv(tenantId: string): Promise<string> {
    const { products } = await this.catalog.listProducts(tenantId, {
      limit: EXPORT_LIMIT,
    });

    const header = [
      'name',
      'name_ar',
      'sku',
      'price',
      'currency',
      'stock',
      'stock_status',
      'category',
      'description',
      'description_ar',
      'tags',
    ];

    const rows = products.map((p) =>
      [
        this.escapeCsv(p.name),
        this.escapeCsv(p.nameAr ?? ''),
        this.escapeCsv(p.sku ?? ''),
        p.price,
        p.currency,
        p.stock,
        p.stockStatus,
        this.escapeCsv(p.category ?? ''),
        this.escapeCsv(p.description ?? ''),
        this.escapeCsv(p.descriptionAr ?? ''),
        this.escapeCsv((p.tags ?? []).join(';')),
      ].join(','),
    );

    return [header.join(','), ...rows].join('\n');
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
    }

    result.push(current.trim());
    return result;
  }

  private buildHeaderMap(header: string[]): Map<string, number> {
    const map = new Map<string, number>();
    header.forEach((h, i) => {
      map.set(h.toLowerCase().replace(/\s+/g, '_'), i);
    });
    return map;
  }

  /** Throws (caught per row by the caller) rather than coercing anything it cannot parse. */
  private mapRowToInput(
    headerMap: Map<string, number>,
    values: string[],
  ): CreateProductInput {
    const get = (key: string): string | undefined => {
      const idx = headerMap.get(key);
      return idx !== undefined && values[idx] ? values[idx] : undefined;
    };

    const name = get('name');
    if (!name) {
      throw new Error('Missing required field: name');
    }

    const rawPrice = get('price');
    if (rawPrice === undefined) {
      throw new Error('Missing required field: price');
    }
    const price = Number(rawPrice);
    if (!Number.isFinite(price)) {
      throw new Error(`Price "${rawPrice}" is not a number`);
    }
    if (price < 0) {
      throw new Error('Price must be non-negative');
    }

    const rawStock = get('stock');
    let stock = 0;
    if (rawStock !== undefined) {
      stock = Number(rawStock);
      if (!Number.isInteger(stock)) {
        throw new Error(`Stock "${rawStock}" is not a whole number`);
      }
      if (stock < 0) {
        throw new Error('Stock must be non-negative');
      }
    }

    const currency = get('currency') ?? 'SAR';
    if (!(CURRENCIES as readonly string[]).includes(currency)) {
      throw new Error(`Unsupported currency "${currency}"`);
    }

    const stockStatus = get('stock_status') ?? 'in_stock';
    if (!(STOCK_STATUSES as readonly string[]).includes(stockStatus)) {
      throw new Error(`Unsupported stock status "${stockStatus}"`);
    }

    return {
      name,
      nameAr: get('name_ar'),
      sku: get('sku'),
      description: get('description'),
      descriptionAr: get('description_ar'),
      price,
      currency,
      stock,
      stockStatus,
      category: get('category'),
      tags: get('tags')?.split(';').filter(Boolean),
    };
  }

  private escapeCsv(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}

function dedupeBySku(rows: readonly ParsedRow[]): ParsedRow[] {
  const bySku = new Map<string, ParsedRow>();
  const withoutSku: ParsedRow[] = [];

  for (const row of rows) {
    if (row.input.sku) bySku.set(row.input.sku, row);
    else withoutSku.push(row);
  }

  return [...bySku.values(), ...withoutSku].sort(
    (a, b) => a.rowNumber - b.rowNumber,
  );
}
