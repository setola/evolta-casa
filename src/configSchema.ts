import { z } from 'zod';

export const SeoPageSchema = z.object({
  slug: z.string().regex(/^\//), locale: z.literal('it'), enabled: z.boolean().default(true),
  seoTitle: z.string().min(10), metaDescription: z.string().min(20), h1: z.string().min(5), intro: z.string().min(10),
  preset: z.record(z.string(), z.unknown()).optional(), contentSlots: z.record(z.string(), z.string()).optional(),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
});

export const AppConfigSchema = z.object({
  market: z.object({ country: z.literal('IT'), currency: z.literal('EUR'), locale: z.literal('it-IT'), assumptionsVersion: z.string() }),
  providers: z.record(z.string(), z.unknown()), map: z.record(z.string(), z.unknown()), solar: z.any(), roof: z.any(), pv: z.any(), battery: z.any(),
  consumptionProfiles: z.any(), electrification: z.any(), ev: z.any(), energyPrices: z.any(), costModels: z.any(), optimizer: z.any(), confidence: z.any(), persistence: z.any(),
  seoPages: z.array(SeoPageSchema), featureFlags: z.any(), legal: z.any(),
}).superRefine((cfg, ctx) => {
  const slugs = new Set<string>();
  for (const page of cfg.seoPages) {
    if (slugs.has(page.slug)) ctx.addIssue({ code: 'custom', path: ['seoPages'], message: `Slug duplicato: ${page.slug}` });
    slugs.add(page.slug);
    for (const slot of Object.keys(page.contentSlots ?? {})) {
      if (!['home.afterHero', 'wizard.ev.beforeForm', 'results.beforeScenarios', 'results.afterScenarios'].includes(slot)) {
        ctx.addIssue({ code: 'custom', path: ['seoPages', page.slug, 'contentSlots'], message: `Slot SEO non ammesso: ${slot}` });
      }
    }
  }
});
