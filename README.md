# siteglass MCP server

[`siteglass-mcp`](https://www.npmjs.com/package/siteglass-mcp) exposes
[siteglass.io](https://siteglass.io) as MCP tools. Two things an AI agent (or a
human) can do with it:

1. **Archive any public URL** — `siteglass_render` renders a page server-side
   and returns a permanent, shareable snapshot: an interactive **rrweb** DOM
   capture (post-JS, selectable text, working links), a single-page **PDF**, or
   a full-page **PNG**. No CAPTCHA, no signup, no ownership check, callable
   programmatically — a bot-friendly alternative to archive.today. (It renders
   JS-heavy pages; it does *not* produce WARC, and if the target itself blocks
   datacenter IPs the capture can come back empty.)
2. **Web-QA an app you built** — **register → verify → scan → generate flows →
   run → read results**, autonomously, no human signup.

Auth is automatic (creates + caches an API key at `~/.siteglass/key`); set
`SITEGLASS_API_KEY` to use your own. The first scan per site is free; after
that, scans (2 credits) and flow runs (1 credit) draw from a prepaid balance
topped up in USD over Bitcoin Lightning.

## Install

```sh
npx siteglass-mcp
```

**Claude Code:**
```sh
claude mcp add siteglass -- npx siteglass-mcp
```

**Cursor / Claude Desktop / Windsurf** — add to the MCP config
(`~/.cursor/mcp.json`, `claude_desktop_config.json`, …):
```json
{
  "mcpServers": {
    "siteglass": { "command": "npx", "args": ["-y", "siteglass-mcp"] }
  }
}
```

**OpenClaw** — add to `~/.openclaw/openclaw.json` (OpenClaw consumes MCP
servers); your assistant gets the `siteglass_*` tools:
```json
{ "mcpServers": { "siteglass": { "command": "npx", "args": ["-y", "siteglass-mcp"] } } }
```

Then ask the agent: *"test my app at <url> with siteglass."*

## Tools

| tool | does |
|------|------|
| `siteglass_render` | archive any public URL → shareable snapshot permalink (rrweb / pdf / png); no CAPTCHA, no signup |
| `siteglass_get_render` | fetch an archive once its Lightning invoice is paid |
| `siteglass_register_site` | register an app URL, get an ownership-proof token |
| `siteglass_verify_site` | confirm the token is live (DNS TXT or hosted) |
| `siteglass_scan` / `siteglass_get_scan` | crawl the site → report + findings (first scan free) |
| `siteglass_generate_flows` | derive executable E2E test flows from a scan |
| `siteglass_run_flow` / `siteglass_get_run` | run a flow → per-step pass/fail, screenshots, video, rrweb replay |
| `siteglass_set_credentials` | give a test login for authenticated flows |
| `siteglass_feedback` | send feedback to the siteglass team |

Long ops return an id and you poll the `get_*` tool, so every call stays
under MCP client request timeouts.

## Discovery

- Listed in the **official MCP Registry** as `io.siteglass/mcp`.
- Machine-discovery on the API host: `https://siteglass.io/openapi.json`,
  `/.well-known/agent-skills/index.json`, `/llms.txt`, `/SKILLS.md`.

MIT licensed.
