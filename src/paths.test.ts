import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(['/', '/evolta-casa/'])('deployment at %s', base => {
  it('prefixes navigation, configuration, images and service worker URLs', async () => {
    vi.stubEnv('BASE_URL', base);
    vi.resetModules();
    const { publicPath } = await import('./paths');
    expect(publicPath('/')).toBe(base);
    for (const path of ['tetto', 'config/assumptions.yaml', 'ui/logo.svg', 'sw.js']) {
      expect(publicPath(`/${path}`)).toBe(`${base}${path}`);
    }
  });

  it('recognizes direct links, trailing slashes and legacy routes', async () => {
    vi.stubEnv('BASE_URL', base);
    vi.resetModules();
    const { appPath } = await import('./paths');
    expect(appPath(base)).toBe('/');
    expect(appPath(base.replace(/\/$/, '') || '/')).toBe('/');
    for (const path of ['tetto', 'pannelli', 'prezzi', 'fotovoltaico-con-batteria']) {
      expect(appPath(`${base}${path}/`)).toBe(`/${path}`);
    }
    expect(appPath('/evolta-casa-extra/tetto')).toBe('/evolta-casa-extra/tetto');
  });
});
