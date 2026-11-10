import { openDB } from "idb";
import { z } from "zod";
import type { Project } from "./types";

const DB = "evolta-casa";
const STORE = "projects";
const DRAFT_KEY = "evolta-casa:current-project";
const ProjectSchema: z.ZodType<Project> = z.any().superRefine((p, ctx) => {
  if (!p?.id || !p.schemaVersion || !p.roof || !p.currentHome)
    ctx.addIssue({ code: "custom", message: "Progetto non valido" });
  if (
    p.currentHome?.electricityInput?.hourlyKwh &&
    p.currentHome.electricityInput.hourlyKwh.length !== 8760
  )
    ctx.addIssue({ code: "custom", message: "Serie oraria non a 8760 ore" });
});
function normalizeRoofLabels(project: Project): Project {
  return {
    ...project,
    roof: {
      ...project.roof,
      planes: project.roof.planes.map((plane, index) => ({
        ...plane,
        label: /^Area(?: \\d+)?$/i.test(plane.label)
          ? `Falda ${index + 1}`
          : plane.label,
      })),
    },
  };
}
async function db() {
  return openDB(DB, 1, {
    upgrade(db) {
      db.createObjectStore(STORE, { keyPath: "id" });
    },
  });
}
export function loadDraftProject(): Project | undefined {
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    return draft
      ? normalizeRoofLabels(ProjectSchema.parse(JSON.parse(draft)))
      : undefined;
  } catch {
    localStorage.removeItem(DRAFT_KEY);
    return undefined;
  }
}
export function saveDraftProject(project: Project) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(project));
  } catch {
    // Storage can be unavailable or full: manual IndexedDB saves still work.
  }
}
export async function saveProject(project: Project) {
  const p = { ...project, updatedAt: new Date().toISOString() };
  await (await db()).put(STORE, p);
  saveDraftProject(p);
  return p;
}
export async function listProjects(): Promise<Project[]> {
  const projects = await (await db()).getAll(STORE);
  return projects.map(normalizeRoofLabels);
}
export async function getProject(id: string): Promise<Project | undefined> {
  const project = await (await db()).get(STORE, id);
  return project ? normalizeRoofLabels(project) : undefined;
}
export async function deleteProject(id: string) {
  await (await db()).delete(STORE, id);
  if (loadDraftProject()?.id === id) localStorage.removeItem(DRAFT_KEY);
}
export async function clearAll() {
  await (await db()).clear(STORE);
  localStorage.removeItem(DRAFT_KEY);
}
export function exportProject(project: Project) {
  return JSON.stringify(project, null, 2);
}
export function importProject(text: string) {
  try {
    const parsed = JSON.parse(text);
    return normalizeRoofLabels(ProjectSchema.parse(parsed));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Import non valido";
    throw new Error(`Import JSON rifiutato: ${message}`);
  }
}
