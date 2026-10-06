// Gulf T6, critical regression #3: WhatsApp media download keeps working now
// that it is reached through `ChannelAdapter.downloadMedia()`.
import type { BspAdapter } from '../whatsapp/ports/bsp-adapter.port';
import { MediaRejectedError } from './ports/media-download.errors';
import { WhatsappChannelAdapter } from './whatsapp-channel.adapter';

function makeAdapter() {
  const downloadMedia = jest.fn().mockResolvedValue({
    content: Buffer.from('ogg bytes'),
    mimeType: 'audio/ogg',
  });
  return {
    adapter: new WhatsappChannelAdapter({
      downloadMedia,
    } as unknown as BspAdapter),
    downloadMedia,
  };
}

describe('WhatsappChannelAdapter.downloadMedia()', () => {
  it("delegates a media id to the BSP's two-hop download, unchanged", async () => {
    const { adapter, downloadMedia } = makeAdapter();

    const media = await adapter.downloadMedia('pn-1', { mediaId: 'media-123' });

    expect(downloadMedia).toHaveBeenCalledWith('pn-1', 'media-123');
    expect(media).toEqual({
      content: Buffer.from('ogg bytes'),
      mimeType: 'audio/ogg',
    });
  });

  it('propagates a BSP failure untouched, so the queue retries it', async () => {
    const { adapter, downloadMedia } = makeAdapter();
    downloadMedia.mockRejectedValue(new Error('HTTP 401'));

    await expect(
      adapter.downloadMedia('pn-1', { mediaId: 'media-123' }),
    ).rejects.toThrow('HTTP 401');
  });

  it('refuses a url handle: WhatsApp media is never fetched by url', async () => {
    const { adapter, downloadMedia } = makeAdapter();

    await expect(
      adapter.downloadMedia('pn-1', {
        mediaUrl: 'https://scontent.xx.fbcdn.net/x.jpg',
      }),
    ).rejects.toBeInstanceOf(MediaRejectedError);
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('passes the inbound media id through as mediaId', () => {
    const adapter = new WhatsappChannelAdapter({
      parseInboundWebhook: () => [
        {
          phoneNumberId: 'pn-1',
          bspMessageId: 'wamid.1',
          from: '15551234567',
          type: 'image',
          media: {
            mediaId: 'media-9',
            mimeType: 'image/jpeg',
            filename: null,
            caption: null,
          },
          receivedAt: new Date(0),
        },
      ],
    } as unknown as BspAdapter);

    const [message] = adapter.parseInboundWebhook('{}');

    expect(message.media).toEqual({
      mediaId: 'media-9',
      mimeType: 'image/jpeg',
      filename: null,
      caption: null,
    });
  });
});
