# sf-preflight for AI coding agents

sf-preflight works with any AI coding agent and any model. Agents get two things:

- **Tools**: the MCP server (`preflight mcp`), which any MCP client can call. Agents with a shell
  can also run the CLI (`npx -y sf-preflight …`).
- **Know-how**: the `sf-preflight` **agent skill**, which tells the agent when to use those tools
  and what to do with the results: analyze after editing metadata, treat high findings as
  blockers, generate tests, never deploy or touch production. It follows the open
  [Agent Skills](https://agentskills.io) format, so one skill works across agents.

Install both. The skill without the tools falls back to the CLI; the tools without the skill
still work, guided by the server's own instructions, but less consistently.

## 1. Install the skill

From your Salesforce DX project:

```bash
npx -y sf-preflight skill install          # this project: .agents/skills and .claude/skills
npx -y sf-preflight skill install --global # every project, for your user
npx -y sf-preflight skill install --dir .github/skills   # somewhere else
```

Commit the project copy so everyone (and every agent) on the repository gets it. Re-run with
`--force` after upgrading sf-preflight.

| Agent | Reads skills from |
|---|---|
| OpenAI Codex | `.agents/skills/`, `~/.agents/skills/` |
| GitHub Copilot and VS Code | `.agents/skills/`, `.github/skills/`, `.claude/skills/` (and the same under `~/`, with `~/.copilot/skills/`) |
| Cursor | `.agents/skills/`, `.cursor/skills/` (also `.claude/skills/`) |
| Gemini CLI | `.agents/skills/`, `.gemini/skills/` |
| Claude Code | `.claude/skills/`, `~/.claude/skills/`, or the [plugin](#claude-code-plugin) |
| Claude apps and the Claude API | upload the `skills/sf-preflight` folder (`npx -y sf-preflight skill path` prints where it is) |
| Other [Agent Skills clients](https://agentskills.io/clients) | their skills folder; `--dir` installs there |

## 2. Add the MCP server

The command is the same everywhere: `npx -y sf-preflight mcp` (Node.js 22.13+). It analyzes the
directory it starts in; add `--root <dir>` for a project in a subfolder. The server is read-only:
it never deploys, writes files or contacts an org unless a tool is given an org alias.

**Claude Code**

```bash
claude mcp add sf-preflight -- npx -y sf-preflight mcp
```

**OpenAI Codex**: `~/.codex/config.toml`

```toml
[mcp_servers.sf-preflight]
command = "npx"
args = ["-y", "sf-preflight", "mcp"]
```

**GitHub Copilot in VS Code**: the [sf-preflight extension](../vscode/README.md) offers the server
to agent mode by itself (VS Code 1.101+). Without the extension, `.vscode/mcp.json`:

```json
{
  "servers": {
    "sf-preflight": { "type": "stdio", "command": "npx", "args": ["-y", "sf-preflight", "mcp"] }
  }
}
```

**Cursor**: `.cursor/mcp.json`, and **Gemini CLI**: `.gemini/settings.json`

```json
{
  "mcpServers": {
    "sf-preflight": { "command": "npx", "args": ["-y", "sf-preflight", "mcp"] }
  }
}
```

**Agentforce Vibes, Windsurf, Cline and other MCP clients**: add a stdio server with command
`npx` and arguments `-y sf-preflight mcp` in the client's MCP settings.

The tools are listed in [MCP.md](MCP.md).

## 3. For agents without skills: AGENTS.md

Agents that don't load skills but read `AGENTS.md` (or a similar instructions file) can get the
essentials from this snippet. Paste it into your project's `AGENTS.md`:

```markdown
## Salesforce changes: sf-preflight

When you create, edit, rename or delete Salesforce metadata (Apex, triggers, flows, validation
rules, fields, permission sets, Agentforce agents):

1. Before adding automation to an object, run `npx -y sf-preflight explain <Object> --event update`.
2. After editing, run `npx -y sf-preflight analyze --base HEAD --format json` (or the
   `analyze_change` MCP tool). Fix high findings, or explain to the user why one is acceptable.
   Don't edit `.preflight.json` to make findings pass.
3. Generate tests with `npx -y sf-preflight tests --base HEAD` and review their NOTE comments.
4. Never deploy, never pass `--allow-production`, never ask for org credentials. For production
   errors use `npx -y sf-preflight incidents --org <alias>` and propose `rollback` plans as a
   pull request.
```

## 4. Check every edit automatically (Claude Code hook)

The skill and the MCP server work when the agent decides to call them. A hook makes it automatic: after each
edit to a Salesforce metadata file, sf-preflight checks what **that edit introduces** (compared with `HEAD`, so the
org's old problems stay out of it) and hands the findings back to the agent, which fixes them in the same turn.

```bash
npx sf-preflight agent-hook install     # in the project; adds a PostToolUse hook to .claude/settings.json
```

It adds this to `.claude/settings.json` at the repository root, keeping your other settings:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "npx --yes sf-preflight@<version> agent-hook", "timeout": 120 }]
      }
    ]
  }
}
```

After an edit that adds, say, DML inside a loop, Claude sees:

> sf-preflight checked force-app/main/default/classes/ContactTriggerHandler.cls: 1 finding(s) this edit introduces …
> - [high] DML/SOQL statement(s) inside loops in ContactTriggerHandler …
> Fix these in your change, or explain to the user why they are acceptable.

Findings at **medium** and above are reported (`--fail-on high` for fewer). Edits to other files, edits that
introduce nothing, and any error in the hook are silent: it never interrupts the agent's turn. Other agents can
run `preflight agent-hook --file <path>` after an edit and read the same JSON.

## Claude Code plugin

For Claude Code, the plugin installs the skill and the MCP server in one step, and adds a hook:
after Claude edits Salesforce metadata, it runs `preflight analyze` on the file and, when there
are high or medium findings, tells Claude straight away.

```text
/plugin marketplace add visparashar/sf-preflight
/plugin install sf-preflight@sf-preflight
```

The hook uses the project's own `sf-preflight` from `node_modules` when there is one, and
otherwise `npx` with the plugin's version. It stays silent for other files and never blocks an
edit. Turn the plugin off in `/plugin` to stop it.

## What every agent should hold to

The skill sets these rules, and the tools enforce the important ones:

- Org access is read-only, except check-only test runs (`tests --validate`) and Testing Center
  runs (`agent-tests`), which refuse production orgs unless `--allow-production` is passed. The
  skill tells agents never to pass it unless the user asks.
- Nothing deploys. Rollbacks are applied to local files and shipped through a pull request.
- Reports carry no record data, record IDs or user names, so agents can quote them safely.
