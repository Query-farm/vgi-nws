import { postJson } from "./http.ts";
import { type Args, arr, json, obj, type Page, provenance, readerWithOptions, str } from "./reader.ts";

export async function riverGlance(a: Args): Promise<Page> {
  if (typeof a.gauge_ids !== "string") throw new Error("gauge_ids must be comma-separated NWS gauge LIDs");
  const ids = a.gauge_ids.split(",").map((s) => s.trim().toUpperCase());
  if (ids.length < 1 || ids.length > 100 || ids.some((s) => !/^[A-Z0-9]{3,10}$/.test(s)))
    throw new Error("Provide 1–100 comma-separated gauge LIDs");
  const doc = await postJson("water", "gauges/raag", { rivers: [...new Set(ids)] });
  const body = obj(doc.body);
  if (typeof body.statusCode === "number" && body.statusCode !== 0 && body.statusCode !== 200)
    throw new Error(`NWPS river-at-a-glance status ${body.statusCode}`);
  return {
    rows: arr(body.rivers).map((r) => {
      const p = obj(r);
      return {
        gauge_id: str(p.lid),
        name: str(p.name),
        office_id: str(p.wfo),
        rfc_id: str(p.rfc),
        flood_statements_json: json(p.floodStatements),
        record_json: json(p),
        ...provenance(doc),
      };
    }),
  };
}
export const WATER_GLANCE_FUNCTIONS = readerWithOptions({
  name: "river_at_a_glance",
  category: "water",
  inputs: { gauge_ids: "text" },
  inputDocs: {
    gauge_ids:
      "Comma-separated NWS gauge LIDs, case-insensitive, with duplicates removed. NULL emits no rows. The reader enforces the documented batch-size limit.",
  },
  description:
    "Read the NWPS River at a Glance view for a bounded list of gauge LIDs. Uses the documented read-only POST endpoint with a rivers array. Retains all original flood statement fields and text; a missing gauge or empty statements is not interpreted as proof of no flood risk. Use stageflow and flood_thresholds for typed measurements and levels.",
  columns: [
    ["gauge_id", "text", "Native gauge LID."],
    ["name", "text", "Gauge name."],
    ["office_id", "text", "Responsible WFO."],
    ["rfc_id", "text", "River forecast center."],
    ["flood_statements_json", "text", "Complete native flood statement array, retaining units and dates."],
    ["record_json", "text", "Original gauge summary record."],
  ],
  read: riverGlance,
  exampleInputs: ["'RMDV2'"],
  example: "SELECT gauge_id, name, flood_statements_json FROM nws.main.river_at_a_glance('RMDV2') ORDER BY gauge_id",
  exampleDescription: "Read flood statements in the River at a Glance view for Richmond-Westham",
});
