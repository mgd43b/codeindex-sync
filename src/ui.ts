/**
 * Terminal output.
 *
 * This tool runs invisibly most of the time, so the moments a human *does* look
 * at it are almost always moments something is wrong. The output rules follow
 * from that:
 *
 *  - Every failure carries a remedy. "qdrant unreachable" is a fact; "start it,
 *    or set QDRANT_URL" is a next step, and the next step is the whole value.
 *  - Empty states teach. A first run showing "no providers configured" should
 *    say how to get one, not just report emptiness.
 *  - Colour is decoration, never meaning. Honour NO_COLOR and non-TTY output so
 *    piping to a file or CI log stays readable.
 */
const useColor =
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb" &&
  process.stdout.isTTY === true;

const wrap = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);

export const style = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

/** Status glyphs degrade to ASCII where Unicode is risky. */
const unicode = process.env["CODEINDEX_ASCII"] === undefined;
export const mark = {
  ok: unicode ? style.green("✔") : "[ok]",
  bad: unicode ? style.red("✘") : "[!!]",
  warn: unicode ? style.yellow("▲") : "[??]",
  info: unicode ? style.blue("•") : "[--]",
};

export function heading(text: string): void {
  process.stdout.write(`\n${style.bold(text)}\n`);
}

export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function ok(text: string): void {
  line(`  ${mark.ok} ${text}`);
}
export function bad(text: string, remedy?: string): void {
  line(`  ${mark.bad} ${text}`);
  if (remedy) line(`      ${style.dim("→")} ${remedy}`);
}
export function warn(text: string, remedy?: string): void {
  line(`  ${mark.warn} ${text}`);
  if (remedy) line(`      ${style.dim("→")} ${remedy}`);
}
export function info(text: string): void {
  line(`  ${mark.info} ${text}`);
}

/**
 * An empty state that teaches rather than just reporting nothing.
 * `next` is the command the user should probably run.
 */
export function empty(what: string, next?: string): void {
  line(`  ${style.dim(what)}`);
  if (next) line(`  ${style.dim("try:")} ${style.cyan(next)}`);
}

/** Left-aligned columns, sized to content. Nothing is truncated silently. */
export function table(
  rows: string[][],
  opts: { indent?: string; right?: number[] } = {},
): void {
  if (rows.length === 0) return;
  const indent = opts.indent ?? "  ";
  // Counts are read by comparing them, which only works when the digits line
  // up, so numeric columns are right-aligned.
  const right = new Set(opts.right ?? []);
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  }
  for (const row of rows) {
    const padded = row.map((cell, i) => {
      const pad = " ".repeat((widths[i] ?? 0) - stripAnsi(cell).length);
      if (right.has(i)) return pad + cell;
      // The last column needs no trailing padding.
      return i === row.length - 1 ? cell : cell + pad;
    });
    line(indent + padded.join("  "));
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Human durations: "in 3s", "2m ago". Precision beyond this is noise. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const secs = Math.round((now - t) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/**
 * Fatal errors: one line saying what happened, one saying what to do.
 * A stack trace is never the first thing a user should see.
 */
export function fail(message: string, remedy?: string): never {
  process.stderr.write(`${mark.bad} ${message}\n`);
  if (remedy) process.stderr.write(`   ${style.dim("→")} ${remedy}\n`);
  process.exit(1);
}
