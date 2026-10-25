import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../src/api/types";
import { initialModel, pickerRows, resolvePick, RESEARCH_PREVIEW_HEADING } from "../src/models";
import { MODELS } from "./fakeApi";

const models = MODELS.data as ModelInfo[];

describe("the model picker", () => {
  it("groups GRT, partner and research preview in that order", () => {
    const rows = pickerRows(models, "grt-small");
    expect(rows.map((r) => (r.kind === "heading" ? `# ${r.label}` : r.model.id))).toEqual([
      "# GRT models",
      "grt-small",
      "grt-large",
      "# Partner models",
      "partner-x",
      `# ${RESEARCH_PREVIEW_HEADING}`,
      "grt-next",
    ]);
  });

  it("shows a model the plan lacks, with the plan that has it, but does not let it be picked", () => {
    const row = pickerRows(models, null).find((r) => r.kind === "model" && r.model.id === "grt-large");
    expect(row).toMatchObject({ selectable: false });
    expect(row?.kind === "model" ? row.description : "").toContain("Team includes it");
    expect(resolvePick(row)).toBeNull();
  });

  it("resolves an included model and never a heading", () => {
    const rows = pickerRows(models, null);
    expect(resolvePick(rows.find((r) => r.kind === "model" && r.model.id === "partner-x"))?.id).toBe("partner-x");
    expect(resolvePick(rows[0])).toBeNull();
  });

  it("never starts on an excluded model, even a remembered one", () => {
    expect(initialModel(models, "grt-large", "grt-large")?.id).toBe("grt-small");
    expect(initialModel(models, "partner-x", "grt-small")?.id).toBe("partner-x");
  });
});
