// Feature 20 (Product Catalog & Stock): REST API for product CRUD.
// Follows CustomerLabelController's conventions: TenantAuthMiddleware for
// identity, EntitlementGuard for "is this tenant allowed to use the product",
// ZodValidationPipe on every body/query, NotFoundException (never a bare
// Error) for a row this tenant cannot see.
//
// ROUTE ORDER IS LOAD-BEARING. Nest matches in declaration order, so every
// literal path segment (`search`, `export`, `import`) must be declared BEFORE
// the `:id` routes — otherwise `GET /catalog/products/export` binds to
// `@Get(':id')` with id="export", fails ParseUUIDPipe, and the advertised
// export endpoint 400/500s instead of returning CSV. Do not reorder.
// (`:id/image` is two segments deep and so cannot be shadowed by `:id`, but
// it still belongs below the literal routes with the rest of them.)
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { CatalogImageService } from './catalog-image.service';
import { CatalogImportService } from './catalog-import.service';
import {
  createProductSchema,
  importCsvSchema,
  listProductsQuerySchema,
  productImageUploadSchema,
  searchProductsQuerySchema,
  updateProductSchema,
  type CreateProductBody,
  type ImportCsvBody,
  type ListProductsQuery,
  type ProductImageUpload,
  type SearchProductsQuery,
  type UpdateProductBody,
} from './catalog.dto';
import { CatalogService } from './catalog.service';
import {
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGE_MIME_TYPES_DESCRIPTION,
} from './product-image';

@ApiTags('Catalog')
@ApiBearerAuth()
@UseGuards(EntitlementGuard)
@Controller('catalog/products')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly importService: CatalogImportService,
    private readonly images: CatalogImageService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a product' })
  async create(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(createProductSchema)) input: CreateProductBody,
  ) {
    return this.catalog.createProduct(auth.tenantId, input);
  }

  @Get()
  @ApiOperation({ summary: 'List products' })
  async list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listProductsQuerySchema))
    query: ListProductsQuery,
  ) {
    return this.catalog.listProducts(auth.tenantId, {
      category: query.category,
      stockStatus: query.stock_status,
      search: query.search,
      limit: query.limit,
      offset: query.offset,
    });
  }

  // --- literal paths: must stay above the `:id` routes (see header) ---

  @Get('search')
  @ApiOperation({ summary: 'Full-text search products' })
  async search(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(searchProductsQuerySchema))
    query: SearchProductsQuery,
  ) {
    return this.catalog.searchProducts(auth.tenantId, query.q, {
      limit: query.limit,
      category: query.category,
    });
  }

  @Get('export')
  @ApiOperation({ summary: 'Export products as CSV' })
  async exportCsv(@CurrentAuth() auth: TenantAuthContext) {
    const csv = await this.importService.exportCsv(auth.tenantId);
    return { csv };
  }

  @Post('import')
  @ApiOperation({ summary: 'Import products from CSV' })
  async importCsv(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(importCsvSchema)) body: ImportCsvBody,
  ) {
    return this.importService.importCsv(auth.tenantId, body.csv);
  }

  // --- parameterised paths ---

  @Get(':id')
  @ApiOperation({ summary: 'Get product by ID' })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const product = await this.catalog.getProduct(auth.tenantId, id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update product' })
  async update(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) input: UpdateProductBody,
  ) {
    const product = await this.catalog.updateProduct(auth.tenantId, id, input);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  @Post(':id/image')
  @ApiOperation({
    summary: 'Upload a product image',
    description: `Stores the photo through the platform object storage and points the product's \`imageUrl\` at \`GET /catalog/products/{id}/image\`. Replacing a photo deletes the object the previous one used.

Limits: at most ${MAX_PRODUCT_IMAGE_BYTES} bytes, and the type must be one of \`${PRODUCT_IMAGE_MIME_TYPES_DESCRIPTION}\` — both the declared MIME type and the file's own magic number are checked, so a mislabelled file is a 400. A product id belonging to another tenant is a 404, indistinguishable from one that does not exist.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Multipart form with a single `file` part.',
    required: true,
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: `A ${PRODUCT_IMAGE_MIME_TYPES_DESCRIPTION} image, at most ${MAX_PRODUCT_IMAGE_BYTES} bytes.`,
        },
      },
    },
  })
  // The ceiling is enforced HERE as well as in the Zod schema: multer buffers
  // the whole part in memory before any pipe runs, so a limit that only lives
  // in validation means a 400 that already cost us the RAM. Exceeding this
  // aborts the stream and answers 413; the schema's `size` bound is the
  // belt-and-braces check for a part that somehow arrives pre-buffered.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_PRODUCT_IMAGE_BYTES, files: 1 },
    }),
  )
  async uploadImage(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile(new ZodValidationPipe(productImageUploadSchema))
    file: ProductImageUpload,
  ) {
    return this.images.uploadImage(auth.tenantId, id, {
      filename: file.originalname,
      mimeType: file.mimetype,
      content: file.buffer,
    });
  }

  @Get(':id/image')
  @ApiOperation({
    summary: 'Download a product image',
    description:
      "The bytes of the photo uploaded for this product. 404 if the product has no uploaded photo — a product whose `imageUrl` came from a store sync points at that store's CDN, not here.\n\nServed with `X-Content-Type-Options: nosniff` and only ever with a content type this API itself accepted at upload time.",
  })
  // The bytes are ours (allowlisted type, magic number verified at upload),
  // but nosniff costs nothing and keeps a future allowlist change from
  // quietly turning this route into a content-hosting surface.
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadImage(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const image = await this.images.getImage(auth.tenantId, id);
    response.setHeader('Content-Type', image.mimeType);
    response.setHeader('Content-Length', image.content.byteLength);
    response.end(image.content);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete product (soft)' })
  async delete(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const deleted = await this.catalog.deleteProduct(auth.tenantId, id);
    if (!deleted) {
      throw new NotFoundException(`Product ${id} not found`);
    }
  }
}
