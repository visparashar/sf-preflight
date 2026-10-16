// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  agentExplanationToMarkdown,
  agentListToMarkdown,
  changeAt,
  checkEdits,
  evaluateGate,
  explainAgent,
  fieldReferences,
  findFixes,
  fixesToMarkdown,
  loadConfig,
  loadProject,
  planRollback,
  rollbackToMarkdown,
  run,
  runTests,
  type SaveEvent,
  saveProcedure,
  sourceRoots,
  testsToMarkdown,
  toMarkdown,
} from "./core/index.js";

const INSTRUCTIONS = `sf-preflight analyzes Salesforce DX metadata changes before they ship.

Use it whenever you create or edit Salesforce metadata (flows, Apex, validation rules, fields,
permission sets):
1. After editing, call analyze_change (no arguments compares the working tree with HEAD).
2. Treat high findings and a failed quality gate as blockers: fix them or explain to the user why
   they are acceptable. (Approval checks in the gate can only pass once a person reviews.)
3. Call generate_tests and add the generated Apex test classes (it returns the code; write the
   files yourself), then review their NOTE comments.
For findings with a mechanical fix, call suggest_fixes: it returns diffs that sf-preflight has
already checked (the finding is gone and nothing new appears). Apply the ones that fit what the
user asked for; fixes of kind "undo" reverse part of the change, so confirm those with the user.
For a finding suggest_fixes has no fix for, write the fix yourself and run check_fix on the new file
contents before writing them: it says whether the finding is gone and whether anything new appears.
Use explain_save_order to understand what already runs on an object before adding automation,
find_field_references before renaming, retyping or deleting a field, and explain_agent before
changing anything an Agentforce agent action calls. When a recent change broke something in
production, use plan_rollback to undo only the components that need it.`;

export interface McpServerOptions {
  /** Directory the server may analyze; tool calls cannot reach outside it. */
  root: string;
  version: string;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const failure = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `preflight: ${(err as Error).message}` }],
});

export function createMcpServer(opts: McpServerOptions): McpServer {
  const root = path.resolve(opts.root);
  const projectDir = (dir?: string) => {
    const abs = path.resolve(root, dir ?? ".");
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`project_dir must be inside ${root}`);
    }
    return abs;
  };
  const projectDirSchema = z
    .string()
    .optional()
    .describe("SFDX project directory, relative to the server root (default: the root itself)");

  const server = new McpServer({ name: "sf-preflight", version: opts.version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "analyze_change",
    {
      title: "Analyze a Salesforce change",
      description:
        "Compute the blast radius of a Salesforce metadata change: what it sets off through flows, triggers, " +
        "validation rules, roll-ups and permissions; recursion cycles, validation-rule collisions, risky " +
        "permission grants; and suggested tests. With no base or files, compares the working tree to HEAD.",
      inputSchema: {
        project_dir: projectDirSchema,
        base: z.string().optional().describe("Git base ref, e.g. origin/main (default: HEAD)"),
        head: z.string().optional().describe("Git head ref (default: the working tree)"),
        files: z
          .array(z.string())
          .optional()
          .describe("Analyze these metadata files instead of a git diff (project-relative or absolute)"),
        format: z.enum(["markdown", "json"]).optional().describe("Report format (default: markdown)"),
        max_depth: z.number().int().min(1).max(8).optional().describe("Maximum cascade depth (default: 4)"),
        org: z
          .string()
          .optional()
          .describe(
            "Alias or username of an org already authorized with `sf org login`. Adds read-only org context: record counts, automation that exists only in the org, permission set assignments.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const dir = projectDir(args.project_dir);
        const result = run({
          projectDir: dir,
          base: args.files?.length ? undefined : (args.base ?? "HEAD"),
          head: args.head,
          files: args.files,
          maxDepth: args.max_depth,
          org: args.org,
        });
        // The project's quality gate, so agents know what CI will require (approvals aren't known here).
        result.gate = evaluateGate({ result, config: loadConfig(dir).config.gate });
        return text(args.format === "json" ? JSON.stringify(result, null, 2) : toMarkdown(result));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "suggest_fixes",
    {
      title: "Suggest checked fixes for a change's findings",
      description:
        "Propose fixes for the findings of a change, as unified diffs. Each fix was checked by analyzing the " +
        "change again with it applied: its finding is gone and no new high or medium finding appears. Kinds: " +
        '"safe" (keeps what the change was for), "undo" (puts one part of the change back as on the base ' +
        'branch) and "review" (mechanical, read it). Nothing is written: apply the diffs yourself.',
      inputSchema: {
        project_dir: projectDirSchema,
        base: z.string().optional().describe("Git base ref, e.g. origin/main (default: HEAD)"),
        files: z
          .array(z.string())
          .optional()
          .describe("Fix the findings of these metadata files instead of a git diff (project-relative or absolute)"),
        rules: z.array(z.string()).optional().describe("Only fixes for these rule ids"),
        format: z.enum(["markdown", "json"]).optional().describe("Report format (default: markdown)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const report = findFixes(
          {
            projectDir: projectDir(args.project_dir),
            base: args.files?.length ? undefined : (args.base ?? "HEAD"),
            files: args.files,
          },
          { rules: args.rules },
        );
        return text(
          args.format === "json"
            ? JSON.stringify({ fixes: report.fixes, rejected: report.rejected, withoutFix: report.withoutFix }, null, 2)
            : fixesToMarkdown(report),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "check_fix",
    {
      title: "Check a fix you wrote for a finding",
      description:
        "Check edits you propose, without writing them: sf-preflight analyzes the change again with the new " +
        "file contents in place and says which findings are gone and which are new. Use it after writing a fix " +
        'the suggest_fixes tool did not offer. Verdict "accepted": a finding is gone and nothing new of ' +
        'high or medium severity appears; "rejected": it is still reported or something blocking is new; ' +
        '"no-effect": the findings are the same. Pass `finding` (a fix id or a rule id) to require that one ' +
        "finding be the one that goes. Then write the files yourself.",
      inputSchema: {
        project_dir: projectDirSchema,
        base: z.string().optional().describe("Git base ref, e.g. origin/main (default: HEAD)"),
        files: z
          .array(z.string())
          .optional()
          .describe("Check the findings of these metadata files instead of a git diff (project-relative or absolute)"),
        edits: z
          .array(
            z.object({
              path: z.string().describe("Project file, relative to the project directory"),
              content: z.string().max(2_000_000).describe("The whole new content of the file"),
            }),
          )
          .min(1)
          .max(20),
        finding: z.string().optional().describe("Fix id or rule id of the finding the edit is meant to fix"),
        format: z.enum(["markdown", "json"]).optional().describe("Report format (default: markdown)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const dir = projectDir(args.project_dir);
        const check = checkEdits(
          { projectDir: dir, base: args.files?.length ? undefined : (args.base ?? "HEAD"), files: args.files },
          Object.fromEntries(args.edits.map((e) => [e.path, e.content])),
          args.finding,
        );
        if (args.format === "json") return text(JSON.stringify(check, null, 2));
        const list = (xs: { severity: string; title: string; id: string }[]) =>
          xs.length ? xs.map((x) => `- ${x.severity}: ${x.title} (\`${x.id}\`)`).join("\n") : "- none";
        return text(
          [
            `## Fix check: ${check.verdict}`,
            "",
            ...(check.reasons.length ? [`${check.reasons.join("; ")}.`, ""] : []),
            "**Gone**",
            list(check.resolved),
            "",
            "**New**",
            list(check.introduced),
          ].join("\n"),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "explain_save_order",
    {
      title: "Explain what runs when an object is saved",
      description:
        "List the automations that run, in Salesforce order of execution, when records of an object are " +
        "inserted, updated, deleted or undeleted — and which other objects each one writes to.",
      inputSchema: {
        object: z.string().describe("Object API name, e.g. Opportunity or Invoice__c"),
        event: z.enum(["insert", "update", "delete", "undelete"]).optional().describe("DML event (default: update)"),
        project_dir: projectDirSchema,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const event: SaveEvent = args.event ?? "update";
        const proc = saveProcedure(loadProject(projectDir(args.project_dir)), args.object, event);
        if (!proc.steps.length) return text(`No modelled automation runs on ${args.object} ${event}.`);
        const lines = proc.steps.map((s) => {
          const writes = s.writes.length ? ` → writes ${s.writes.map((w) => `${w.object} (${w.op})`).join(", ")}` : "";
          const notes = s.notes.length ? ` [${s.notes.join("; ")}]` : "";
          return `${s.order}. ${s.phaseLabel}: ${s.automation.name}${writes}${notes}`;
        });
        return text([`${args.object} — ${event}`, ...lines].join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "explain_agent",
    {
      title: "Explain an Agentforce agent",
      description:
        "For an Agentforce agent in the project: its topics and actions, the Apex class or flow each action " +
        "calls, the records it saves (including the automation that follows), the access its runtime user " +
        "needs, and which Testing Center tests cover it. Without an agent name, lists the agents.",
      inputSchema: {
        agent: z.string().optional().describe("Agent API name, e.g. Sales_Agent (omit to list agents)"),
        project_dir: projectDirSchema,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const model = loadProject(projectDir(args.project_dir));
        if (!args.agent) return text(agentListToMarkdown(model));
        const e = explainAgent(model, args.agent);
        if (!e) return failure(new Error(`No agent named ${args.agent} in the project.`));
        return text(agentExplanationToMarkdown(e));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "find_field_references",
    {
      title: "Find references to a field",
      description:
        "List validation rules, flows, Apex, formula fields, roll-up summaries and permission sets that " +
        "reference a field. Use before renaming, retyping or deleting it.",
      inputSchema: {
        object: z.string().describe("Object API name, e.g. Opportunity"),
        field: z.string().describe("Field API name, e.g. Contract_Signed_Date__c"),
        project_dir: projectDirSchema,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const refs = fieldReferences(loadProject(projectDir(args.project_dir)), args.object, args.field);
        if (!refs.length) return text(`No references to ${args.object}.${args.field} found.`);
        return text(
          [
            `${refs.length} reference(s) to ${args.object}.${args.field}:`,
            ...refs.map(
              (r) =>
                `- ${r.from.kind} ${r.from.name}${r.via ? ` through ${r.via}` : ""}${r.from.file ? ` (${r.from.file})` : ""}`,
            ),
          ].join("\n"),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "generate_tests",
    {
      title: "Generate Apex tests for a change",
      description:
        "Generate Apex tests for what a Salesforce change touches: bulk saves at 200 records, recursion along " +
        "automation cycles, flows not applied twice, and invocable actions surfacing validation errors. Returns " +
        "a summary plus the Apex classes (a runtime data factory and a test class) as code; nothing is written " +
        "to disk. With no base or files, uses the working tree versus HEAD.",
      inputSchema: {
        project_dir: projectDirSchema,
        base: z.string().optional().describe("Git base ref, e.g. origin/main (default: HEAD)"),
        head: z.string().optional().describe("Git head ref (default: the working tree)"),
        files: z.array(z.string()).optional().describe("Use these metadata files as the change instead of a git diff"),
        prefix: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_]{0,20}$/)
          .optional()
          .describe('Prefix for generated class names (default "Preflight")'),
        bulk_size: z.number().int().min(1).max(10000).optional().describe("Records per bulk test (default 200)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const dir = projectDir(args.project_dir);
        const { tests } = runTests({
          projectDir: dir,
          base: args.files?.length ? undefined : (args.base ?? "HEAD"),
          head: args.head,
          files: args.files,
          prefix: args.prefix,
          bulkSize: args.bulk_size,
        });
        const files = tests.files.map((f) => {
          const lang = f.path.endsWith(".cls") ? "apex" : "xml";
          return `#### ${f.path}\n\n\`\`\`${lang}\n${f.content.trimEnd()}\n\`\`\``;
        });
        return text(
          [
            testsToMarkdown(tests, { sourceDirs: sourceRoots(dir) }),
            files.length ? "\n### Files\n\nWrite these into a package directory, e.g. force-app/main/default/:" : "",
            ...files,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "plan_rollback",
    {
      title: "Plan a partial rollback",
      description:
        "Plan a partial rollback of a commit or merged pull request: which of its components to restore to " +
        "their previous version, which new flows, validation rules or triggers to deactivate, what must come " +
        "along to keep the rollback consistent, and the commands to ship it as a pull request. Nothing is " +
        "changed: it returns the plan.",
      inputSchema: {
        commit: z.string().describe("Commit or merge commit to roll back, e.g. a SHA or HEAD~2"),
        components: z
          .array(z.string())
          .optional()
          .describe('Components to roll back, e.g. ["Opportunity.Require_Close_Reason"] (default: all it changed)'),
        project_dir: projectDirSchema,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const dir = projectDir(args.project_dir);
        const change = changeAt(dir, args.commit);
        return text(
          rollbackToMarkdown(
            planRollback({ projectDir: dir, model: loadProject(dir), change, components: args.components }),
          ),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const server = createMcpServer(opts);
  await server.connect(new StdioServerTransport());
}
