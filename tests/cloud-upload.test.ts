import { describe, expect, it } from 'vitest';
import { cloudFileUrl, parseShareLink } from '../packages/upload/cloud-upload';

describe('cloud share links', () => {
  it('parses OpenCloud and Nextcloud links, also in a subpath or with index.php', () => {
    expect(parseShareLink('https://cloud.example.org/s/AbC123')).toEqual({ base: 'https://cloud.example.org', token: 'AbC123' });
    expect(parseShareLink(' https://example.org/nextcloud/index.php/s/xYz-9_ ')).toEqual({ base: 'https://example.org/nextcloud', token: 'xYz-9_' });
    expect(parseShareLink('https://cloud.example.org/s/AbC123?dir=/')).toEqual({ base: 'https://cloud.example.org', token: 'AbC123' });
    expect(() => parseShareLink('https://cloud.example.org/f/123')).toThrow();
    expect(() => parseShareLink('kein link')).toThrow();
  });

  it('builds the WebDAV upload URLs', () => {
    const link = { base: 'https://cloud.example.org', token: 'AbC123' };
    expect(cloudFileUrl('opencloud', link, 'predigt_eag_2026-10-18.mp3')).toBe('https://cloud.example.org/dav/public-files/AbC123/predigt_eag_2026-10-18.mp3');
    expect(cloudFileUrl('nextcloud', link, 'a b.mp3')).toBe('https://cloud.example.org/public.php/dav/files/AbC123/a%20b.mp3');
  });
});
