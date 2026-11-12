import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const cfg = YAML.parse(fs.readFileSync('public/config/assumptions.yaml','utf8'));
const dist = 'dist';
const base = process.env.BASE_PATH || '/';
const siteUrl = process.env.SITE_URL;
const publicUrl = route => {
  const pathname = `${base}${route.replace(/^\/+/, '')}`;
  return siteUrl ? new URL(pathname, siteUrl).href : pathname;
};
if (!fs.existsSync(dist)) process.exit(0);
const indexPath = path.join(dist,'index.html');
const index = fs.readFileSync(indexPath,'utf8');
const enabled = (cfg.seoPages ?? []).filter(p => p.enabled);
// Keep /pannelli as a legacy app-shell entry; the client replaces it with /tetto.
const appRoutes = ['/trova-casa', '/tetto', '/pannelli', '/consumi', '/casa-futura', '/mobilita', '/prezzi', '/risultati'];
for (const route of appRoutes) {
  const dir = path.join(dist, route.replace(/^\//,''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), index);
}
for (const page of enabled) {
  const dir = path.join(dist, page.slug.replace(/^\//,''));
  fs.mkdirSync(dir, { recursive: true });
  const html = index
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(page.seoTitle)}</title>`)
    .replace(/<meta name="description" content=".*?"\/>/, `<meta name="description" content="${escapeHtml(page.metaDescription)}"/><link rel="canonical" href="${escapeHtml(publicUrl(page.slug))}"/><meta property="og:title" content="${escapeHtml(page.seoTitle)}"/><meta property="og:description" content="${escapeHtml(page.metaDescription)}"/>`)
    .replace('<div id="root"></div>', `<article style="position:absolute;left:-9999px"><h1>${escapeHtml(page.h1)}</h1><p>${escapeHtml(page.intro)}</p>${(page.faq??[]).map(f=>`<h2>${escapeHtml(f.question)}</h2><p>${escapeHtml(f.answer)}</p>`).join('')}</article><div id="root"></div>`);
  fs.writeFileSync(path.join(dir,'index.html'), html);
}
const urls = ['/', ...enabled.map(p=>p.slug)].map(u=>`  <url><loc>${escapeHtml(publicUrl(u))}</loc></url>`).join('\n');
fs.writeFileSync(path.join(dist,'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
function escapeHtml(s='') { return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
