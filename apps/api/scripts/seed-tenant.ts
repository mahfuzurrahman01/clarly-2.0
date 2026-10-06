/**
 * Seeds ONE working tenant so the WhatsApp loop can be exercised
 * end-to-end. Until this existed there was no way to do that at all:
 * nothing in the codebase ever wrote a real `whatsapp_numbers` row
 * (`BspCredentialsEncryptionService` had zero production callers), so the
 * inbound path could never resolve a tenant and the outbound path could
 * never find a credential to send with.
 *
 * This is deliberately a DEV/OPERATOR script, not a product feature. The
 * product answer is self-serve onboarding (Meta Embedded Signup, Gulf T3),
 * which is still unbuilt — see
 * docs/decisions/T0-bsp-selection.md. This makes the manual step
 * repeatable; it does not make it automatic.
 *
 * It boots a real Nest application context rather than talking to Postgres
 * directly, so every write goes through the same services the app uses —
 * in particular `BspCredentialsEncryptionService.encrypt()` (AES-256-GCM)
 * and `TenantPolicyService.upsert()` (RLS-scoped). Reimplementing either
 * here would be a second source of truth for credential encryption.
 *
 * Usage — new tenant:
 *   SEED_ACCESS_TOKEN=EAAG... \      # Meta Cloud API access token
 *   npm run db:seed --workspace=api -- \
 *     --name "Acme Support" \
 *     --phone-number-id 1195456503655549 \
 *     [--kb ./fixtures/shipping.txt] [--persona "Warm and concise."]
 *
 * Usage — add knowledge/persona to an EXISTING tenant (no credential needed;
 * `phone_number_id` is unique, so a tenant already holding a number cannot be
 * re-seeded as a new one):
 *   npm run db:seed --workspace=api -- \
 *     --tenant-id <uuid> --kb ./fixtures/demo-business [--persona "..."]
 *
 * `--kb` accepts a single .txt file or a directory, in which case every
 * .txt inside is ingested in filename order.
 *
 * The credential comes from the ENVIRONMENT, never a flag, and is never
 * logged or echoed. That is not fussiness: npm reprints the full failing
 * command (argv included) on any non-zero exit, so a `--access-token` flag
 * would spill a live credential into terminal scrollback and CI logs on
 * every failed run. It is written nowhere but the encrypted column.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  kbDocuments,
  whatsappNumbers,
  tenants,
} from '../src/modules/persistence/drizzle/schema';
import { PersistenceService } from '../src/modules/persistence/persistence.service';
import { TenantContextService } from '../src/modules/tenant-context/tenant-context.service';
import { TenantPolicyService } from '../src/modules/onboarding/tenant-policy.service';
import { RetrievalIngestService } from '../src/modules/retrieval/retrieval-ingest.service';
import { BspCredentialsEncryptionService } from '../src/modules/whatsapp/bsp-credentials-encryption.service';

interface Args {
  name: string;
  /** When set, attach to this existing tenant instead of creating one. */
  tenantId?: string;
  phoneNumberId?: string;
  credentials: Record<string, string>;
  kbPath?: string;
  persona?: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag.startsWith('--')) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Flag ${flag} needs a value.`);
      }
      flags.set(flag.slice(2), value);
      i += 1;
    }
  }

  const tenantId = flags.get('tenant-id');
  const phoneNumberId = flags.get('phone-number-id');
  // Credentials come from the environment, never argv — see the header.
  const accessToken = process.env.SEED_ACCESS_TOKEN;

  if (flags.has('access-token')) {
    throw new Error(
      'Pass the credential as SEED_ACCESS_TOKEN in the environment, not as a flag — npm echoes argv on failure, which would leak it.',
    );
  }
  if (tenantId) {
    // Existing-tenant mode: the number and its credential already exist.
    if (phoneNumberId) {
      throw new Error(
        '--tenant-id and --phone-number-id are mutually exclusive: the existing tenant already owns its number.',
      );
    }
    if (!flags.has('kb') && !flags.has('persona')) {
      throw new Error(
        '--tenant-id needs --kb and/or --persona to do anything.',
      );
    }
  } else {
    if (!phoneNumberId) {
      throw new Error('--phone-number-id is required (or --tenant-id).');
    }
    if (!accessToken) {
      throw new Error(
        'Set SEED_ACCESS_TOKEN (the Meta Cloud API access token for this number).',
      );
    }
  }

  return {
    name: flags.get('name') ?? 'Seeded Tenant',
    tenantId,
    phoneNumberId,
    // MetaCloudAdapter reads `accessToken` from the encrypted blob.
    credentials: {
      ...(accessToken ? { accessToken } : {}),
    },
    kbPath: flags.get('kb'),
    persona: flags.get('persona'),
  };
}

/** `--kb` is a single .txt or a directory of them; directories ingest in filename order so numbered prefixes control sequence. */
async function resolveKbFiles(kbPath: string): Promise<string[]> {
  const info = await stat(kbPath);
  if (!info.isDirectory()) {
    return [kbPath];
  }
  const entries = await readdir(kbPath);
  return entries
    .filter((entry) => entry.endsWith('.txt'))
    .sort()
    .map((entry) => join(kbPath, entry));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const persistence = app.get(PersistenceService);
    const tenantContext = app.get(TenantContextService);
    const tenantPolicy = app.get(TenantPolicyService);
    const encryption = app.get(BspCredentialsEncryptionService);

    let tenantId: string;

    if (args.tenantId) {
      tenantId = args.tenantId;
      console.log(`tenant        ${tenantId}  (existing)`);
    } else {
      // 1. Tenant. Not RLS-scoped (it is the row RLS scopes everything
      //    else against), so it goes through the admin query path.
      const [tenant] = await persistence.runAdminQuery((db) =>
        db.insert(tenants).values({ name: args.name }).returning(),
      );
      tenantId = tenant.id;
      console.log(`tenant        ${tenantId}  (${args.name})`);

      // 3. The WhatsApp number -> tenant mapping, with real AES-256-GCM
      //    ciphertext. This is the row the inbound path resolves and the
      //    outbound path decrypts.
      await persistence.runAdminQuery((db) =>
        db.insert(whatsappNumbers).values({
          tenantId,
          phoneNumberId: args.phoneNumberId!,
          bspCredentialsEncrypted: encryption.encrypt(args.credentials),
        }),
      );
      console.log(
        `whatsapp_number ${args.phoneNumberId} -> tenant (credentials encrypted: ${Object.keys(args.credentials).join(', ')})`,
      );
    }

    // 2. Policy row. STRICTLY required — RespondPathProcessor throws
    //    without one rather than defaulting, so a tenant seeded without
    //    this would fail every turn (Feature 2.5/T15). upsert() means
    //    re-running with a new --persona just updates it.
    await tenantPolicy.upsert(tenantId, {
      confidenceThreshold: 0.5,
      ...(args.persona ? { tonePersonaOverride: args.persona } : {}),
    });
    console.log(
      `tenant_policy upserted (confidenceThreshold 0.5${args.persona ? ', persona set' : ''})`,
    );

    // 4. Optional KB document, ingested synchronously. Without it the
    //    agent still answers — but it escalates KB_NOT_INDEXED instead of
    //    resolving, which makes an end-to-end test much less convincing.
    if (args.kbPath) {
      const files = await resolveKbFiles(args.kbPath);
      let totalChunks = 0;

      for (const file of files) {
        const content = await readFile(file);
        const kbDocumentId = randomUUID();
        const filename = basename(file);

        await tenantContext.withTenantTx(
          (tx) =>
            tx.insert(kbDocuments).values({
              id: kbDocumentId,
              tenantId,
              filename,
              storageKey: `${tenantId}/${kbDocumentId}`,
              mimeType: 'text/plain',
              sizeBytes: content.byteLength,
              status: 'uploaded',
            }),
          tenantId,
        );

        // Direct ingest rather than KbDocumentService.upload(): that path
        // enqueues a job, which would require a running worker to
        // complete. A seed script should finish having done the work.
        const { chunkCount } = await app
          .get(RetrievalIngestService)
          .ingestDocument({
            tenantId,
            kbDocumentId,
            content,
            mimeType: 'text/plain',
          });
        totalChunks += chunkCount;
        console.log(`kb_document   ${filename} -> ${chunkCount} chunks`);
      }
      console.log(`              ${totalChunks} chunks indexed in total`);
    }

    console.log(`\nDone. Point the BSP webhook at POST /webhooks/whatsapp.`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // Never re-print argv here — it contains the credential.
  console.error(
    `seed-tenant failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
