import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker(base: string) {
  const handlers: Record<string, (event: any) => void> = {};
  const addAll = vi.fn(async (_urls: string[]) => undefined);
  const put = vi.fn(async () => undefined);
  const match = vi.fn(async (_url: unknown): Promise<Response | undefined> => undefined);
  const fetch = vi.fn(async () => new Response('network'));
  const open = vi.fn(async () => ({ addAll, put }));
  vm.runInNewContext(fs.readFileSync('public/sw.js', 'utf8'), {
    self: {
      location: { href: `${base}sw.js` },
      addEventListener: (name: string, callback: (event: any) => void) => { handlers[name] = callback; },
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
    },
    caches: { open, match }, fetch, URL, Response,
  });
  async function request(url: string, mode = 'navigate', method = 'GET') {
    let response: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    handlers.fetch({
      request: { url, mode, method },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      respondWith: (promise: Promise<Response>) => { response = promise; },
    });
    const result = await response;
    await Promise.all(pending);
    return result;
  }
  return { handlers, addAll, put, match, fetch, open, request };
}

describe.each(['https://example.com/', 'https://example.com/evolta-casa/'])('worker at %s', base => {
  it('precaches only URLs under its installation path', async () => {
    const w = worker(base);
    let install: Promise<unknown> | undefined;
    w.handlers.install({ waitUntil: (promise: Promise<unknown>) => { install = promise; } });
    await install;
    expect(w.addAll.mock.calls[0][0]).toEqual([
      base, `${base}index.html`, `${base}manifest.webmanifest`, `${base}config/assumptions.yaml`, `${base}icon.svg`,
    ]);
  });
  it('ignores external requests and non-GET methods', async () => {
    const w = worker(base);
    expect(await w.request('https://other.example/icon.svg')).toBeUndefined();
    expect(await w.request(base, 'navigate', 'POST')).toBeUndefined();
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it('uses the scoped app shell offline only for navigations', async () => {
    const w = worker(base);
    w.fetch.mockRejectedValue(new Error('offline'));
    w.match.mockImplementation(async url => String(url) === `${base}index.html` ? new Response('shell') : undefined);
    expect(await (await w.request(`${base}tetto/`))!.text()).toBe('shell');
    expect((await w.request(`${base}missing.js`, 'cors'))!.type).toBe('error');
  });
});
