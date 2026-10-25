import type { ModelInfo } from "./api/types";

/**
 * The model picker's grouping, the same three groups as the web picker
 * (`web/src/lib/models.ts`): GRT models first, partner models after them,
 * research previews last with their disclosure. The list itself is the
 * server's -- already narrowed to the org's allow-list -- so nothing here
 * decides what exists, only how it is laid out and what may be chosen.
 */

export const PARTNER_MODELS_HEADING = "Partner models";
export const RESEARCH_PREVIEW_HEADING = "Research preview — not for real use";
export const GRT_HEADING = "GRT models";

export interface ModelGroups {
  models: ModelInfo[];
  partners: ModelInfo[];
  researchPreviews: ModelInfo[];
}

export function groupModels(models: readonly ModelInfo[]): ModelGroups {
  const groups: ModelGroups = { models: [], partners: [], researchPreviews: [] };
  for (const model of models) {
    if (model.research_preview) groups.researchPreviews.push(model);
    else if (model.partner) groups.partners.push(model);
    else groups.models.push(model);
  }
  return groups;
}

/** `32768` -> `32k`, `2000000` -> `2M`. */
export function formatContextWindow(window: number | null | undefined): string | null {
  if (window === null || window === undefined) return null;
  if (window >= 1_000_000 && window % 1_000_000 === 0) return `${window / 1_000_000}M`;
  if (window >= 1_000) return `${Math.round(window / 1_000)}k`;
  return `${window}`;
}

/** One row of the QuickPick: a heading, or a model that may or may not be choosable. */
export type PickerRow =
  | { kind: "heading"; label: string }
  | { kind: "model"; model: ModelInfo; label: string; description: string; selectable: boolean };

/**
 * The rows the picker shows. A model the plan does not include stays visible
 * with the plan that has it -- hiding it would hide that it exists -- but is
 * not selectable; the API's turn gate refuses it anyway, and offering a
 * choice that is guaranteed to fail is worse than showing why.
 */
export function pickerRows(models: readonly ModelInfo[], currentId: string | null): PickerRow[] {
  const rows: PickerRow[] = [];
  const groups = groupModels(models);
  const section = (heading: string, list: ModelInfo[]) => {
    if (list.length === 0) return;
    rows.push({ kind: "heading", label: heading });
    for (const model of list) {
      const notes: string[] = [];
      const ctx = formatContextWindow(model.context_window);
      if (ctx) notes.push(`${ctx} context`);
      if (!model.included) {
        notes.push(model.upgrade_to ? `Not on your plan — ${model.upgrade_to} includes it` : "Not on your plan");
      }
      rows.push({
        kind: "model",
        model,
        label: `${model.id === currentId ? "$(check) " : ""}${model.included ? "" : "$(lock) "}${model.label || model.id}`,
        description: notes.join(" · "),
        selectable: model.included,
      });
    }
  };
  section(GRT_HEADING, groups.models);
  section(PARTNER_MODELS_HEADING, groups.partners);
  section(RESEARCH_PREVIEW_HEADING, groups.researchPreviews);
  return rows;
}

/** The model a chosen row resolves to, or null when it may not be chosen. */
export function resolvePick(row: PickerRow | undefined): ModelInfo | null {
  if (!row || row.kind !== "model" || !row.selectable) return null;
  return row.model;
}

/** The model to start with: the remembered one if it is still allowed, else the server's default. */
export function initialModel(
  models: readonly ModelInfo[],
  remembered: string | null,
  serverDefault: string | null,
): ModelInfo | null {
  const allowed = models.filter((m) => m.included);
  return (
    allowed.find((m) => m.id === remembered) ??
    allowed.find((m) => m.id === serverDefault) ??
    allowed[0] ??
    null
  );
}
