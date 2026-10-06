// Feature 20 (Product Catalog & Stock): product photos.
//
// Separate from CatalogService on purpose. CatalogService is the tenant-scoped
// DB layer and knows nothing about buckets; this service composes it with the
// platform ObjectStorage port — the SAME port KB documents and inbound
// WhatsApp media already use (StorageModule), including its
// `${tenantId}/${uuid}` key scheme. A second storage abstraction living in a
// feature module would be a third place to get tenant prefixing wrong.
//
// Every write still goes through CatalogService, so it inherits
// `withTenantTx()` and the `products` RLS policy rather than reaching past
// them with a raw handle.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppConfigService, AppLoggerService } from '../core';
import { ObjectStorage } from '../storage/ports/object-storage.port';
import { CatalogService, type ProductRecord } from './catalog.service';
import {
  PRODUCT_IMAGE_MIME_TYPES_DESCRIPTION,
  hasProductImageSignature,
  isProductImageMimeType,
  productImageUrl,
} from './product-image';

export interface ProductImageUpload {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface ProductImageDownload {
  content: Buffer;
  mimeType: string;
}

/** Where the upload records the served content type. `products` has no column for it, and one jsonb key is not worth a migration. */
const MIME_METADATA_KEY = 'imageMimeType';
const SIZE_METADATA_KEY = 'imageSizeBytes';

@Injectable()
export class CatalogImageService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly storage: ObjectStorage,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Attaches a photo to a product the caller's tenant owns.
   *
   * Ownership is checked BEFORE the bytes are stored: uploading first and
   * discovering the 404 afterwards would let any authenticated tenant write
   * into the bucket by guessing product ids, and would leave the object
   * behind when it failed.
   */
  async uploadImage(
    tenantId: string,
    productId: string,
    upload: ProductImageUpload,
  ): Promise<ProductRecord> {
    // Before anything is read or stored: the upload's whole product is a
    // durable `image_url`, and without an absolute base URL there is no
    // correct value to write. Degrading to a root-relative one would store
    // a row that no client can resolve and that raises no error anywhere —
    // a permanently blank thumbnail. A 503 naming the missing variable is
    // the only failure an operator can actually see and fix.
    if (!this.config.apiPublicBaseUrl) {
      throw new ServiceUnavailableException(
        'Product image upload is unavailable: API_PUBLIC_BASE_URL is not configured',
      );
    }

    const existing = await this.catalog.getProduct(tenantId, productId);
    if (!existing) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    // The declared MIME type already passed the allowlist in the DTO; this is
    // the half a caller cannot forge by setting a header.
    if (!hasProductImageSignature(upload.mimeType, upload.content)) {
      throw new BadRequestException(
        `File content is not a valid ${upload.mimeType} image — accepted types are ${PRODUCT_IMAGE_MIME_TYPES_DESCRIPTION}`,
      );
    }

    const stored = await this.storage.upload(
      tenantId,
      upload.filename,
      upload.content,
    );

    const updated = await this.catalog.updateProduct(tenantId, productId, {
      imageObjectKey: stored.storageKey,
      imageUrl: productImageUrl(
        this.config.apiPublicBaseUrl,
        productId,
        stored.storageKey,
      ),
      // Merged, not replaced: `metadata` is shared with store sync, whose
      // `storeExternalId` is how F24's stock webhooks find this row.
      metadata: {
        ...existing.metadata,
        [MIME_METADATA_KEY]: upload.mimeType,
        [SIZE_METADATA_KEY]: stored.sizeBytes,
      },
    });

    if (!updated) {
      // Deleted between the read and the write. A 404 is the honest answer;
      // the freshly stored object is cleaned up on the way out.
      await this.deleteObject(stored.storageKey, productId);
      throw new NotFoundException(`Product ${productId} not found`);
    }

    // Best-effort, and deliberately after the row is committed: losing the
    // old object matters far less than losing the new row, and the bucket is
    // the one place a failure here is merely wasteful.
    if (
      existing.imageObjectKey &&
      existing.imageObjectKey !== stored.storageKey
    ) {
      await this.deleteObject(existing.imageObjectKey, productId);
    }

    return updated;
  }

  /**
   * The bytes behind a product's photo. Another tenant's product id 404s
   * exactly as a non-existent one does — `getProduct` is tenant-scoped, so
   * the two are indistinguishable from here.
   */
  async getImage(
    tenantId: string,
    productId: string,
  ): Promise<ProductImageDownload> {
    const product = await this.catalog.getProduct(tenantId, productId);
    if (!product?.imageObjectKey) {
      throw new NotFoundException(`Product ${productId} has no stored image`);
    }

    const content = await this.storage.download(product.imageObjectKey);
    const recorded = product.metadata[MIME_METADATA_KEY];

    return {
      content,
      // Only ever a type this endpoint itself accepted. A product whose
      // image_url came from a store sync has no recorded type, and echoing
      // an arbitrary stored string back as Content-Type is how a bucket
      // becomes a content-hosting surface.
      mimeType:
        typeof recorded === 'string' && isProductImageMimeType(recorded)
          ? recorded
          : 'application/octet-stream',
    };
  }

  private async deleteObject(
    storageKey: string,
    productId: string,
  ): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (error) {
      this.logger.warn(
        `Failed to delete product image object ${storageKey} for product ${productId}: ${error instanceof Error ? error.message : String(error)}`,
        CatalogImageService.name,
      );
    }
  }
}
