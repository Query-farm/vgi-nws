import {
  batchFromColumns,
  defineRowTransformFunction,
  float64,
  parentRowsMetadata,
  schema,
  timestampMillis,
  utf8,
} from "@query-farm/vgi";
import { column, objectTags } from "./meta.ts";
import { interval } from "./weather.ts";

const description =
  "Decode an NWS validTime interval into UTC start/end times and its duration in hours without requesting a forecast. Supports day/time ISO8601 durations or an explicit end timestamp; calendar months and years are rejected.";
export const parseValidTime = defineRowTransformFunction({
  name: "parse_valid_time",
  description,
  args: { valid_time: utf8() },
  argDocs: { valid_time: "NWS interval such as 2026-01-02T12:00:00Z/PT2H. NULL produces no rows." },
  onBind: () => ({
    outputSchema: schema([
      column("valid_from", timestampMillis("UTC"), "UTC start of the interval."),
      column("valid_to", timestampMillis("UTC"), "UTC exclusive end of the interval."),
      column("duration_hours", float64(), "Duration in hours, preserving fractional values."),
    ]),
  }),
  process: (params, batch, out) => {
    const starts: number[] = [],
      ends: number[] = [],
      durations: number[] = [],
      parents: number[] = [];
    for (let i = 0; i < batch.numRows; i++) {
      const value = batch.getChild("valid_time")?.get(i);
      if (value == null) continue;
      const [start, end] = interval(String(value));
      starts.push(start);
      ends.push(end);
      durations.push((end - start) / 3600000);
      parents.push(i);
    }
    out.emit(
      batchFromColumns({ valid_from: starts, valid_to: ends, duration_hours: durations }, params.outputSchema),
      parentRowsMetadata(parents, starts.length),
    );
  },
  tags: {
    ...objectTags({
      title: "Parse NWS validity interval",
      category: "reference",
      keywords: "NWS, validTime, ISO8601, interval, duration",
      docLlm:
        description +
        " The positional valid_time argument accepts a column or literal. The function is deterministic and makes no network requests.",
      docMd: `${description}\n\nIntervals are not resampled; a two-hour validity window remains one row.`,
    }),
    "vgi.result_columns_schema": JSON.stringify([
      { name: "valid_from", type: "TIMESTAMP WITH TIME ZONE", description: "UTC start of the interval." },
      { name: "valid_to", type: "TIMESTAMP WITH TIME ZONE", description: "UTC exclusive end of the interval." },
      { name: "duration_hours", type: "DOUBLE", description: "Duration in hours." },
    ]),
    "vgi.executable_examples": JSON.stringify([
      {
        description: "A two-hour NWS forecast interval",
        sql: "SELECT duration_hours FROM nws.main.parse_valid_time('2026-01-02T12:00:00Z/PT2H') ORDER BY valid_from",
        expected_result: [[2]],
      },
    ]),
  },
  examples: [
    {
      sql: "SELECT valid_from, valid_to, duration_hours FROM nws.main.parse_valid_time('2026-01-02T12:00:00Z/PT2H') ORDER BY valid_from",
      description: "Decode a two-hour NWS forecast validity interval",
    },
  ],
});
