import type { FileDescription, JobLogMessage, ObjectDescription, ServiceProgramExport, WhereUsedRow } from "./codeForIBMi";

/**
 * Plain-text reports of what the research tools find, for a read-only editor document: a human's
 * Find Where Used, Describe File and so on. Kept free of the `vscode` module so it can be unit tested.
 */

/** Widest a column gets before its values are cut short. */
const MAX_COLUMN_WIDTH = 60;

/** Rows as aligned columns under a header, each column as wide as its widest value (up to a limit). */
export function textTable(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const cell = (value: string) => {
    const text = value.replace(/\s+/g, " ");
    return text.length > MAX_COLUMN_WIDTH ? `${text.substring(0, MAX_COLUMN_WIDTH - 1)}…` : text;
  };
  const table = [headers.map(cell), ...rows.map((row) => headers.map((_, i) => cell(row[i] ?? "")))];
  const widths = headers.map((_, i) => Math.max(...table.map((row) => row[i].length)));
  const line = (row: readonly string[]) =>
    row.map((value, i) => (i === row.length - 1 ? value : value.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(table[0]), widths.map((width) => "-".repeat(width)).join("  "), ...table.slice(1).map(line)];
}

export interface WhereUsedReportInput {
  object: string;
  objectType?: string;
  system: string;
  librariesSearched: readonly string[];
  librariesLeftOut?: readonly string[];
  librariesNotRead?: ReadonlyArray<{ library: string; error: string }>;
  rows: readonly WhereUsedRow[];
}

/** DSPPGMREF's usage code for files, in words. */
export function describeUsage(usage: string | undefined): string {
  if (!usage) {
    return "";
  }
  const code = Number(usage);
  if (!Number.isInteger(code)) {
    return usage;
  }
  const parts = [code & 1 ? "input" : "", code & 2 ? "output" : "", code & 4 ? "update" : "", code & 8 ? "unspecified" : ""].filter(Boolean);
  return parts.join(", ");
}

export function whereUsedReport(input: WhereUsedReportInput): string {
  const lines = [
    `Where Used: ${input.object}${input.objectType ? ` (${input.objectType})` : ""} on ${input.system}`,
    `Libraries searched: ${input.librariesSearched.join(", ") || "none"}`,
  ];
  if (input.librariesLeftOut?.length) {
    lines.push(`Not searched (over the limit): ${input.librariesLeftOut.join(", ")}`);
  }
  for (const failed of input.librariesNotRead ?? []) {
    lines.push(`Could not read ${failed.library}: ${failed.error}`);
  }
  lines.push("");
  if (input.rows.length === 0) {
    lines.push("No program or service program in these libraries refers to it.");
  } else {
    lines.push(`${input.rows.length} program(s) refer to it:`, "");
    const sorted = [...input.rows].sort((a, b) => a.library.localeCompare(b.library) || a.program.localeCompare(b.program));
    lines.push(...textTable(
      ["Library", "Program", "As", "Usage", "Text"],
      sorted.map((row) => [row.library, row.program, `${row.objectLibrary}/${input.object} ${row.objectType}`, describeUsage(row.usage), row.text])
    ));
  }
  return lines.join("\n") + "\n";
}

const TABLE_TYPES: Record<string, string> = {
  T: "SQL table", P: "physical file", L: "logical file", V: "view", A: "alias", M: "materialized query table",
};

export function fileDescriptionReport(file: FileDescription, system: string): string {
  const lines = [
    `File: ${file.library}/${file.systemName}${file.sqlName !== file.systemName ? ` (SQL name ${file.sqlName})` : ""} on ${system}`,
    `Type: ${TABLE_TYPES[file.type] ?? file.type}`,
    ...(file.text ? [`Text: ${file.text}`] : []),
    "",
    `${file.columns.length} column(s):`,
    "",
    ...textTable(
      ["Column", "System name", "Type", "Length", "Null", "Text"],
      file.columns.map((column) => [
        column.name,
        column.systemName,
        column.type,
        column.scale !== undefined && column.scale > 0 ? `${column.length},${column.scale}` : String(column.length),
        column.nullable ? "yes" : "",
        column.text,
      ])
    ),
  ];
  if (file.dependents) {
    lines.push("", file.dependents.length === 0 ? "Nothing is built over it." : `${file.dependents.length} object(s) built over it:`, "");
    if (file.dependents.length > 0) {
      lines.push(...textTable(["Library", "Name", "Type"], file.dependents.map((d) => [d.library, d.name, d.type])));
    }
  }
  if (file.notes.length > 0) {
    lines.push("", ...file.notes.map((note) => `Note: ${note}`));
  }
  return lines.join("\n") + "\n";
}

function keyValues(values: Record<string, string>): string[] {
  const keys = Object.keys(values);
  const width = Math.max(0, ...keys.map((key) => key.length));
  return keys.map((key) => `${key.padEnd(width)}  ${values[key]}`);
}

export function objectDescriptionReport(object: ObjectDescription, system: string): string {
  const lines = [`${object.type === "*SRVPGM" ? "Service program" : "Program"}: ${object.library}/${object.name} on ${system}`, "", ...keyValues(object.object)];
  if (object.program) {
    lines.push("", "Program information:", ...keyValues(object.program));
  }
  const table = (title: string, rows: Array<Record<string, string>> | undefined) => {
    if (!rows) {
      return;
    }
    lines.push("", rows.length === 0 ? `${title}: none` : `${title}:`, "");
    if (rows.length > 0) {
      const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      lines.push(...textTable(headers, rows.map((row) => headers.map((header) => row[header] ?? ""))));
    }
  };
  table("Modules", object.modules);
  table("Bound service programs", object.boundServicePrograms);
  if (object.notes.length > 0) {
    lines.push("", ...object.notes.map((note) => `Note: ${note}`));
  }
  return lines.join("\n") + "\n";
}

export function serviceProgramExportsReport(
  program: { library: string; name: string; exports: readonly ServiceProgramExport[] },
  system: string
): string {
  const lines = [`Service program ${program.library}/${program.name} on ${system} exports ${program.exports.length} symbol(s):`, ""];
  if (program.exports.length > 0) {
    lines.push(...textTable(["Symbol", "Usage"], program.exports.map((e) => [e.symbol, e.usage])));
  }
  return lines.join("\n") + "\n";
}

export function jobLogReport(log: { job: string; messages: readonly JobLogMessage[] }, system: string): string {
  const lines = [`Job log of ${log.job === "*" ? "this connection's job" : log.job} on ${system}: ${log.messages.length} message(s), oldest first`, ""];
  for (const message of log.messages) {
    lines.push(`${message.sent}  ${message.id || "(no id)"}  ${message.type}  severity ${message.severity}${message.fromProgram ? `  from ${message.fromProgram}` : ""}`);
    lines.push(`  ${message.text}`);
    if (message.help) {
      lines.push(...message.help.split(/\r?\n/).map((line) => `    ${line}`));
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The object type a source member of this type usually compiles to, for a where-used search. */
export function objectTypeForSourceType(extension: string): "*FILE" | undefined {
  const type = extension.toUpperCase();
  return ["PF", "LF", "DSPF", "PRTF", "ICFF", "TABLE", "VIEW", "INDEX", "ALIAS"].includes(type) ? "*FILE" : undefined;
}
