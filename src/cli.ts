#!/usr/bin/env node
import { Command } from "commander";
import { Queue, nowIso } from "./queue.js";
import { homedir } from "node:os";
import path from "node:path";

const STATE_DIR =
  process.env["CODEINDEX_SYNC_STATE"] ?? path.join(homedir(), ".local/state/codeindex-sync");

const program = new Command();
program
  .name("codeindex-sync")
  .description("Git-hook-driven index sync worker for MCP code-search backends")
  .version("0.1.0");

program
  .command("enqueue <repo>")
  .description("Queue a repository for indexing")
  .option("--hook <name>", "originating git hook", "manual")
  .option("--full", "force a complete reindex", false)
  .action((repo: string, opts: { hook: string; full: boolean }) => {
    const q = new Queue(path.join(STATE_DIR, "queue"));
    const job = q.enqueue({ repoPath: path.resolve(repo), hook: opts.hook, full: opts.full });
    console.log(`queued ${job.repoPath} (${job.hook}) at ${job.enqueuedAt}`);
  });

program
  .command("status")
  .description("Show the queue")
  .action(() => {
    const q = new Queue(path.join(STATE_DIR, "queue"));
    const jobs = q.list();
    console.log(`state: ${STATE_DIR}`);
    console.log(`queued: ${jobs.length}`);
    for (const j of jobs) {
      console.log(`  ${j.repoPath}  (${j.hook}, queued ${j.enqueuedAt}${j.full ? ", full" : ""})`);
    }
    if (!jobs.length) console.log(`  (empty as of ${nowIso()})`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
