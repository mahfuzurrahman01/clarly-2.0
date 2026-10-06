import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { KbDocumentController } from './kb-document.controller';
import type { KbDocumentRecord } from './kb-document.dto';
import type { KbDocumentService } from './kb-document.service';
import { recordingAudit } from '../audit/__fixtures__/recording-audit';

const AUTH: TenantAuthContext = {
  userId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'admin',
};

function makeFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'faq.md',
    encoding: '7bit',
    mimetype: 'text/markdown',
    size: 1024,
    buffer: Buffer.from('# FAQ'),
    destination: '',
    filename: '',
    path: '',
    stream: undefined as never,
    ...overrides,
  };
}

function makeController(): {
  controller: KbDocumentController;
  kbDocuments: {
    upload: jest.Mock;
    listForTenant: jest.Mock;
    getForTenant: jest.Mock;
    delete: jest.Mock;
  };
} {
  const kbDocuments = {
    upload: jest.fn(),
    listForTenant: jest.fn(),
    getForTenant: jest.fn(),
    delete: jest.fn(),
  };
  const controller = new KbDocumentController(
    kbDocuments as unknown as KbDocumentService,
  );
  return { controller, kbDocuments };
}

describe('KbDocumentController', () => {
  it("list() lists the caller's own tenant documents", async () => {
    const { controller, kbDocuments } = makeController();
    const docs: KbDocumentRecord[] = [];
    kbDocuments.listForTenant.mockResolvedValue(docs);

    await expect(controller.list(AUTH)).resolves.toBe(docs);
    expect(kbDocuments.listForTenant).toHaveBeenCalledWith('tenant-a');
  });

  it("upload() forwards the file to the caller's own tenant", async () => {
    const { controller, kbDocuments } = makeController();
    const record = { id: 'doc-1' } as KbDocumentRecord;
    kbDocuments.upload.mockResolvedValue(record);
    const file = makeFile();

    const result = await controller.upload(AUTH, file);

    expect(result).toBe(record);
    expect(kbDocuments.upload).toHaveBeenCalledWith(
      'tenant-a',
      'faq.md',
      'text/markdown',
      file.buffer,
    );
  });

  it('upload() rejects when no file is attached', async () => {
    const { controller } = makeController();

    await expect(controller.upload(AUTH, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    'text/plain',
    'text/csv',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ])('upload() accepts %s', async (mimetype) => {
    const { controller, kbDocuments } = makeController();
    kbDocuments.upload.mockResolvedValue({ id: 'doc-1' });

    await expect(
      controller.upload(AUTH, makeFile({ mimetype })),
    ).resolves.toBeDefined();
  });

  it.each(['image/png', 'application/zip', 'application/msword'])(
    'upload() rejects %s',
    async (mimetype) => {
      const { controller } = makeController();

      await expect(
        controller.upload(AUTH, makeFile({ mimetype })),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('upload() rejects a file over the size limit', async () => {
    const { controller } = makeController();
    const file = makeFile({ size: 11 * 1024 * 1024 });

    await expect(controller.upload(AUTH, file)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('KbDocumentController.get()', () => {
  it("reads only within the caller's own tenant", async () => {
    const { controller, kbDocuments } = makeController();
    const record = { id: 'doc-1' } as KbDocumentRecord;
    kbDocuments.getForTenant.mockResolvedValue(record);

    await expect(controller.get(AUTH, 'doc-1')).resolves.toBe(record);
    expect(kbDocuments.getForTenant).toHaveBeenCalledWith('tenant-a', 'doc-1');
  });
});

describe('KbDocumentController.remove()', () => {
  it("deletes only within the caller's own tenant", async () => {
    const { controller, kbDocuments } = makeController();
    kbDocuments.delete.mockResolvedValue({
      filename: 'refund-policy.pdf',
      chunkCount: 3,
    });

    await expect(
      controller.remove(AUTH, 'doc-1', { describe: () => {} }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(kbDocuments.delete).toHaveBeenCalledWith('tenant-a', 'doc-1');
  });

  it('propagates a not-found rather than reporting a delete that never happened', async () => {
    const { controller, kbDocuments } = makeController();
    kbDocuments.delete.mockRejectedValue(new NotFoundException('nope'));

    await expect(
      controller.remove(AUTH, 'doc-1', { describe: () => {} }),
    ).rejects.toThrow(NotFoundException);
  });

  // A uuid in the audit trail tells a reviewer nothing six months from now.
  it('describes the deletion by filename for the audit trail', async () => {
    const { controller, kbDocuments } = makeController();
    kbDocuments.delete.mockResolvedValue({
      filename: 'refund-policy.pdf',
      chunkCount: 3,
    });
    const audit = recordingAudit();

    await controller.remove(AUTH, 'doc-1', audit);

    expect(audit.recorded[0]).toMatchObject({
      key: 'kb_document.deleted',
      params: { filename: 'refund-policy.pdf', chunkCount: 3 },
    });
    expect(audit.described).toEqual([
      'Deleted knowledge-base document "refund-policy.pdf" (3 retrieval chunk(s) removed)',
    ]);
  });
});
