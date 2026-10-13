// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeRef, detectAiTools, RULES, run, toMarkdown, toSarif } from "../src/core/index.js";
import { renderRulesMarkdown } from "../src/core/rules.js";
import { createMcpServer } from "../src/mcp.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const FIELD = `${SRC}/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml`;

// A throwaway git repo with the fixture under sfdx/ (so paths differ from the repo root).
let repo: string;
let project: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args], {
    cwd: repo,
    stdio: "pipe",
  });

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-m2-"));
  project = path.join(repo, "sfdx");
  cpSync(FIXTURE, project, { recursive: true });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("tag", "base");
  // A human commit and an AI-assisted commit touching the project.
  writeFileSync(path.join(project, "README.md"), "changed by a human\n");
  git("commit", "-q", "-am", "docs: tweak readme");
  writeFileSync(
    path.join(project, SRC, "classes/OpportunityCloser.cls"),
    `public with sharing class OpportunityCloser {
    @InvocableMethod
    public static void closeWon(List<Id> ids) {
        List<Opportunity> opps = [SELECT Id FROM Opportunity WHERE Id IN :ids];
        for (Opportunity o : opps) { o.StageName = 'Closed Won'; update o; }
    }
}
`,
  );
  git(
    "commit",
    "-q",
    "-am",
    "feat: close deals from the agent\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
  );
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("assertSafeRef", () => {
  it("accepts normal refs and rejects option-like or malformed ones", () => {
    for (const ok of ["main", "origin/main", "HEAD~1", "v0.1.0", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"]) {
      expect(assertSafeRef(ok)).toBe(ok);
    }
    for (const bad of ["--output=/tmp/x", "-p", "main branch", "a..b", "", "x\ny"]) {
      expect(() => assertSafeRef(bad)).toThrow(/Invalid git/);
    }
  });

  it("is enforced by run()", () => {
    expect(() => run({ projectDir: project, base: "--output=/tmp/pwned" })).toThrow(/Invalid git base ref/);
  });
});

describe("AI-assisted commit detection", () => {
  it("recognises common tool trailers, markers and bot authors", () => {
    expect(detectAiTools("x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", "Dev <d@x>")).toEqual([
      "Claude",
    ]);
    expect(detectAiTools("x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)", "Dev <d@x>")).toEqual([
      "Claude",
    ]);
    expect(detectAiTools("x\n\nCo-authored-by: Copilot <copilot@github.com>", "Dev <d@x>")).toEqual(["GitHub Copilot"]);
    expect(detectAiTools("fix", "devin-ai-integration[bot] <x@users.noreply.github.com>")).toEqual(["Devin"]);
    expect(detectAiTools("x\n\nAssisted-by: SomeNewTool", "Dev <d@x>")).toEqual(["AI (declared)"]);
  });

  it("does not flag humans who share a tool's name", () => {
    expect(detectAiTools("x\n\nCo-authored-by: Claude Monet <claude@example.com>", "Claude Dupont <c@x>")).toEqual([]);
    expect(detectAiTools("plain commit", "Dev <d@x>")).toEqual([]);
  });

  it("summarises the analyzed range and shows it in the report", () => {
    const r = run({ projectDir: project, base: "base" });
    expect(r.provenance).toMatchObject({ range: "base..HEAD", commits: 2, aiAssistedCommits: 1, tools: ["Claude"] });
    expect(r.projectPathInRepo).toBe("sfdx");
    expect(toMarkdown(r)).toContain("1 of 2 commit(s) are AI-assisted** (Claude)");
  });
});

describe("SARIF output", () => {
  it("produces valid-looking SARIF 2.1.0 with repo-relative locations and rule metadata", () => {
    const r = run({ projectDir: project, base: "base" });
    const sarif = toSarif(r, { toolVersion: "9.9.9" }) as {
      version: string;
      runs: {
        tool: { driver: { name: string; version: string; rules: { id: string }[] } };
        results: {
          ruleId: string;
          level: string;
          locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[];
        }[];
        properties: { aiAssistedCommits: number };
      }[];
    };
    expect(sarif.version).toBe("2.1.0");
    const runOut = sarif.runs[0]!;
    expect(runOut.tool.driver).toMatchObject({ name: "sf-preflight", version: "9.9.9" });
    const loop = runOut.results.find((x) => x.ruleId === "dml-or-soql-in-loop")!;
    expect(loop.level).toBe("error");
    expect(loop.locations[0]!.physicalLocation.artifactLocation.uri).toBe(`sfdx/${SRC}/classes/OpportunityCloser.cls`);
    expect(loop.locations[0]!.physicalLocation.region.startLine).toBe(5);
    // Every result has a location and a rule entry.
    const ruleIds = new Set(runOut.tool.driver.rules.map((x) => x.id));
    for (const res of runOut.results) {
      expect(res.locations).toHaveLength(1);
      expect(ruleIds.has(res.ruleId)).toBe(true);
    }
    expect(runOut.properties.aiAssistedCommits).toBe(1);
  });

  it("keeps docs/RULES.md in sync with the rule catalog (run `npm run docs:rules`)", () => {
    expect(readFileSync(path.resolve(__dirname, "../docs/RULES.md"), "utf8")).toBe(renderRulesMarkdown());
  });

  it("has catalog metadata for every rule the analyzer emits", () => {
    const r = run({ projectDir: FIXTURE, files: [path.join(FIXTURE, FIELD)] });
    const known = new Set(RULES.map((x) => x.id));
    for (const f of r.findings) expect(known.has(f.rule)).toBe(true);
  });
});

describe("MCP server", () => {
  let client: Client;
  beforeAll(async () => {
    const server = createMcpServer({ root: repo, version: "0.0.0-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });
  afterAll(async () => {
    await client.close();
  });

  const textOf = (res: Awaited<ReturnType<Client["callTool"]>>) =>
    (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

  it("advertises read-only tools and usage instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "analyze_change",
      "explain_agent",
      "explain_save_order",
      "find_field_references",
      "generate_tests",
      "plan_rollback",
      "suggest_fixes",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(client.getInstructions()).toContain("analyze_change");
  });

  it("analyze_change compares the working tree with HEAD by default", async () => {
    writeFileSync(
      path.join(project, SRC, "objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Contract_Signed_Date__c</fullName>
    <label>Contract Signed</label>
    <type>DateTime</type>
</CustomField>
`,
    );
    const res = await client.callTool({ name: "analyze_change", arguments: { project_dir: "sfdx" } });
    const out = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(out).toContain("## Preflight: 🔴 HIGH risk");
    expect(out).toContain("Opportunity.Contract_Signed_Date__c");
    git("checkout", "-q", "--", ".");
  });

  it("suggest_fixes returns checked diffs and writes nothing", async () => {
    const file = `${SRC}/permissionsets/Agent_Runtime_User.permissionset-meta.xml`;
    const before = readFileSync(path.join(project, file), "utf8");
    const res = await client.callTool({
      name: "suggest_fixes",
      arguments: { project_dir: "sfdx", files: [file], rules: ["permission-escalation"], format: "json" },
    });
    expect(res.isError).toBeFalsy();
    const json = JSON.parse(textOf(res));
    expect(json.fixes.length).toBeGreaterThan(0);
    expect(
      json.fixes.every((f: { rule: string; kind: string }) => f.rule === "permission-escalation" && f.kind === "undo"),
    ).toBe(true);
    expect(json.fixes[0].diff).toContain("-        <modifyAllRecords>true</modifyAllRecords>");
    expect(readFileSync(path.join(project, file), "utf8")).toBe(before);
  });

  it("analyze_change supports explicit files and JSON", async () => {
    const res = await client.callTool({
      name: "analyze_change",
      arguments: {
        project_dir: "sfdx",
        files: [`${SRC}/permissionsets/Agent_Runtime_User.permissionset-meta.xml`],
        format: "json",
      },
    });
    const json = JSON.parse(textOf(res));
    expect(json.findings.some((f: { rule: string }) => f.rule === "permission-escalation")).toBe(true);
  });

  it("explain_save_order and find_field_references answer from the project", async () => {
    const explain = textOf(
      await client.callTool({ name: "explain_save_order", arguments: { object: "Contact", project_dir: "sfdx" } }),
    );
    expect(explain).toContain("After trigger: ContactTrigger → writes Account (update)");
    const refs = textOf(
      await client.callTool({
        name: "find_field_references",
        arguments: { object: "Opportunity", field: "Contract_Signed_Date__c", project_dir: "sfdx" },
      }),
    );
    expect(refs).toContain("ValidationRule Require_Contract_Signed_Date");
  });

  it("refuses to reach outside its root and reports errors as tool errors", async () => {
    const outside = await client.callTool({
      name: "explain_save_order",
      arguments: { object: "Account", project_dir: "../.." },
    });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain("must be inside");
    const badRef = await client.callTool({
      name: "analyze_change",
      arguments: { project_dir: "sfdx", base: "--upload-pack=evil" },
    });
    expect(badRef.isError).toBe(true);
  });
});
