---
name: Library/wyattkuhns/Mikiedi
tags:
  - meta/library
description: Mikiedi (Memory Wiki Editor) — publish, sync, and manage Cadet memory pages from SilverBullet
---

Mikiedi connects this SilverBullet space to a Cadet assistant's memory store through the Mikiedi bridge plugin (installed on the Cadet side). Pages published from here are validated, revision-guarded (CAS), snapshotted, and journaled before they reach Cadet memory; conflicts are preserved, never auto-resolved.

**Settings** live in the Workbench → **Configuration** tab, under the **Mikiedi** category (Bridge URL + Bridge token). They are saved to `Library/Config` and survive reloads.

Commands (command palette):

| Command | What it does |
| --- | --- |
| `Mikiedi: Pull all pages from Cadet` | Fetch the whole memory store into this space (real slugs); local edits are never overwritten |
| `Mikiedi: Publish current page` | Validates and publishes this page into Cadet memory |
| `Mikiedi: Publish pages…` | Pick a page to publish |
| `Mikiedi: Refresh from Cadet` | Pull the canonical version of this page, with conflict safety |
| `Mikiedi: Delete page from Cadet` | CAS-guarded deletion of this page from Cadet memory, with confirmations |
| `Mikiedi: Resolve conflict` | Keep Cadet's version or publish this space's version for a recorded conflict |
| `Mikiedi: Show panel` | The v0.3 panel: operation log with timestamps, per-page version history, git-style diffs, undo/redo, toolbar (Config / Help / Issues / Info) — also a top-bar button (book icon) |
| `Mikiedi: Undo current page` | Step the Cadet copy of this page back to its previous state |
| `Mikiedi: Redo current page` | Step the Cadet copy forward again (after an undo) |
| `Mikiedi: Apply retention now` | Prune the Cadet-side log and version history per the configured retention |
| `Mikiedi: Open help` | Open (or create) the Mikiedi/Help page |
| `Mikiedi: Status` | Write a `Mikiedi/Status` page: sync state, conflicts, refresh state |
| `Mikiedi: Adopt Cadet state` | Record baselines for pages that already exist in Cadet memory |

Retention (how long the Cadet side keeps the operation log vs full page versions — seconds/minutes/hours/days/years, or forever/never) is configured in Workbench → Configuration → Mikiedi. See `Mikiedi: Open help` for the full guide.

Library pages (`Library/…`), the `CONFIG` page, and other `Mikiedi/…` pages are never published.

```space-lua
-- priority: 40
-- Mikiedi — Memory Wiki Editor. Publishes SilverBullet pages into Cadet
-- memory through the bridge plugin's ingress route. See the repo README
-- for the full conflict model and recovery guide.

-- Schema registration is best-effort: config.define* are pcall-guarded so the
-- library still loads on SB builds without the configuration schema API.
pcall(function()
  if type(config.defineCategory) == "function" then
    config.defineCategory {
      name = "Mikiedi",
      description = "Memory Wiki Editor bridge settings.",
      priority = 25,
    }
  end
  if type(config.define) == "function" then
    config.define("mikiedi.bridgeUrl", {
      type = "string",
      default = "",
      ui = {
        category = "Mikiedi",
        label = "Bridge URL",
        priority = 10,
        description = "Full URL of the bridge ingress route.",
      },
    })
    config.define("mikiedi.bridgeToken", {
      type = "string",
      default = "",
      ui = {
        category = "Mikiedi",
        label = "Bridge token",
        priority = 9,
        inputType = "password",
        description = "Bearer token stored on the Cadet side (field bridge_token, service mikiedi). Anyone who can edit this space could read it — that is the same trust level as publishing.",
      },
    })
    config.define("mikiedi.autoRefresh", {
      type = "boolean",
      default = true,
      ui = {
        category = "Mikiedi",
        label = "Auto-refresh retrieval index",
        priority = 8,
        description = "When on, every publish or delete also invalidates Cadet's retrieval index (the recommended default). Turn off only if the Cadet side refreshes on its own schedule.",
      },
    })
    config.define("mikiedi.pullExclusions", {
      type = "string",
      default = "",
      ui = {
        category = "Mikiedi",
        label = "Pull exclusions",
        priority = 7,
        description = "Comma-separated slug prefixes that 'Pull all pages from Cadet' skips, e.g. 'drafts/, scratch/'. Exact slugs also match. Empty means pull everything.",
      },
    })
    config.define("mikiedi.logRetentionAmount", {
      type = "string",
      default = "30",
      ui = {
        category = "Mikiedi",
        label = "Log retention: amount",
        priority = 6,
        description = "How many units to keep the bridge operation log (journal). Used with the unit dropdown. Ignored when the unit is forever or never.",
      },
    })
    config.define("mikiedi.logRetentionUnit", {
      type = "string",
      enum = { "seconds", "minutes", "hours", "days", "years", "forever", "never" },
      default = "days",
      ui = {
        category = "Mikiedi",
        label = "Log retention: unit",
        priority = 6,
        description = "Unit for the log amount. forever keeps the log indefinitely; never stops recording new log entries (existing history is kept until a prune).",
      },
    })
    config.define("mikiedi.versionRetentionAmount", {
      type = "string",
      default = "90",
      ui = {
        category = "Mikiedi",
        label = "Version retention: amount",
        priority = 5,
        description = "How many units to keep full page versions (the copies behind the panel's diff viewer and undo/redo). Used with the unit dropdown. Ignored when the unit is forever or never.",
      },
    })
    config.define("mikiedi.versionRetentionUnit", {
      type = "string",
      enum = { "seconds", "minutes", "hours", "days", "years", "forever", "never" },
      default = "forever",
      ui = {
        category = "Mikiedi",
        label = "Version retention: unit",
        priority = 5,
        description = "Unit for the version amount. forever keeps every version (undo/redo always available); never records no versions at all, which disables undo/redo.",
      },
    })
  end
end)

-- Top-bar action button so the panel is one click away, next to the
-- standard SilverBullet menu buttons (falls back to raw config injection
-- on builds without the Std actionButton API).
pcall(function()
  local spec = {
    icon = "book-open",
    description = "Mikiedi panel — log, versions, diffs, undo/redo",
    command = "Mikiedi: Show panel",
    priority = 1.5,
    dropdown = false,
  }
  if type(actionButton) == "table" and type(actionButton.define) == "function" then
    actionButton.define(spec)
  else
    local btns = config.get("actionButtons", {})
    table.insert(btns, spec)
  end
end)

local mikiedi = {}

-- Per-tab session id: each browser tab evaluates this library separately, so
-- two tabs produce two distinct sessions. The bridge uses it for the
-- multi-tab stomp guard (a publish from another session inside the window
-- is refused with a "refresh first" advisory instead of overwriting).
local MIKIEDI_SESSION = os.date("!%Y%m%dT%H%M%SZ") .. "-" .. tostring(math.random(100000, 999999))
mikiedi.session = MIKIEDI_SESSION

mikiedi.retention_unit_spec = function(amount, unit)
  if unit == "forever" or unit == "never" then return unit end
  local letters = { seconds = "s", minutes = "m", hours = "h", days = "d", years = "y" }
  local n = tonumber(amount)
  if n == nil or n <= 0 then n = 30 end
  return string.format("%g%s", n, letters[unit] or "d")
end

-- Retention payload for state-changing ops, composed from the config fields.
mikiedi.retention = function()
  local ok1, la = pcall(config.get, "mikiedi.logRetentionAmount", "30")
  local ok2, lu = pcall(config.get, "mikiedi.logRetentionUnit", "days")
  local ok3, va = pcall(config.get, "mikiedi.versionRetentionAmount", "90")
  local ok4, vu = pcall(config.get, "mikiedi.versionRetentionUnit", "forever")
  return {
    log = mikiedi.retention_unit_spec(ok1 and la or "30", ok2 and lu or "days"),
    versions = mikiedi.retention_unit_spec(ok3 and va or "90", ok4 and vu or "forever"),
  }
end

mikiedi.main_slug = function(payload)
  if type(payload.slug) == "string" and payload.slug ~= "" then return payload.slug end
  if type(payload.pages) == "table" and type(payload.pages[1]) == "table" then
    return tostring(payload.pages[1].slug or "")
  end
  return ""
end

-- Persistent operation log page (Mikiedi/Log), newest last, capped at 200
-- rows. The Cadet-side journal remains the authoritative log; this page is
-- the in-space view the panel and readers use. Never published (Mikiedi/*).
mikiedi.append_log = function(op, slug, outcome, detail)
  local name = "Mikiedi/Log"
  local rows = {}
  local ok, existing = pcall(space.readPage, name)
  if ok and type(existing) == "string" then
    for line in existing:gmatch("[^\n]+") do
      if line:sub(1, 2) == "| " and not line:match("^| Timestamp") and not line:match("^| %-%-%-") then
        table.insert(rows, line)
      end
    end
  end
  local stamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
  local det = tostring(detail or ""):gsub("|", "/"):gsub("[\r\n]+", " ")
  if #det > 160 then det = det:sub(1, 157) .. "..." end
  table.insert(rows, "| " .. stamp .. " | " .. tostring(op or "?") .. " | " .. tostring(slug or "") .. " | " .. tostring(outcome or "?") .. " | " .. det .. " |")
  while #rows > 200 do table.remove(rows, 1) end
  local body = {
    "# Mikiedi log",
    "",
    "Recent bridge operations from this space, newest last. Maintained automatically; not published to Cadet.",
    "",
    "| Timestamp | Op | Slug | Outcome | Detail |",
    "| --- | --- | --- | --- | --- |",
  }
  for _, r in ipairs(rows) do table.insert(body, r) end
  space.writePage(name, table.concat(body, "\n"))
end

mikiedi.is_excluded = function(name)
  return name:match("^Library/") ~= nil
    or name:match("^Mikiedi/") ~= nil
    or name == "Mikiedi"
    or name == "CONFIG"
end

mikiedi.check_slug = function(slug)
  if slug == nil or slug == "" then return false, "Mikiedi: empty page name" end
  if #slug > 200 then return false, "Mikiedi: page name exceeds 200 characters" end
  if slug:sub(1, 1) == "/" or slug:sub(-1) == "/" or slug:find("//", 1, true) then
    return false, "Mikiedi: page name must not have leading/trailing/double slashes"
  end
  for seg in slug:gmatch("[^/]+") do
    if #seg > 80 then
      return false, "Mikiedi: page-name segment exceeds 80 characters: " .. seg
    end
    if not seg:match("^[a-z0-9%-]+$") then
      return false,
        "Mikiedi: '"
          .. slug
          .. "' is not a valid Cadet slug (lowercase letters, digits, hyphens; folders separated by /). Rename the page first — slugs are Cadet's identity for a page, so the bridge never renames silently."
    end
  end
  return true
end

mikiedi.settings = function()
  local url, token = "", ""
  local ok1, u = pcall(config.get, "mikiedi.bridgeUrl", "")
  if ok1 and type(u) == "string" then url = u end
  local ok2, t = pcall(config.get, "mikiedi.bridgeToken", "")
  if ok2 and type(t) == "string" then token = t end
  local opts = { autoRefresh = true, pullExclusions = {} }
  local okA, a = pcall(config.get, "mikiedi.autoRefresh", true)
  if okA and type(a) == "boolean" then opts.autoRefresh = a end
  local okX, x = pcall(config.get, "mikiedi.pullExclusions", "")
  if okX and type(x) == "string" and x ~= "" then
    for pat in x:gmatch("[^,]+") do
      local p = pat:gsub("%s+", "")
      if p ~= "" then table.insert(opts.pullExclusions, p) end
    end
  end
  return url, token, opts
end

mikiedi.excluded_from_pull = function(slug, exclusions)
  for _, pat in ipairs(exclusions or {}) do
    if slug == pat or slug:sub(1, #pat) == pat then return true end
  end
  return false
end

mikiedi.refresh_flag = function()
  local _, _, opts = mikiedi.settings()
  if opts.autoRefresh then return nil end
  return false -- explicit "do not refresh" for the bridge payload
end

local STATE_CHANGING_OPS = { publish = true, delete = true, resolve = true, undo = true, redo = true, prune = true }

mikiedi.call = function(payload)
  local url, token = mikiedi.settings()
  if url == "" then
    error("Mikiedi: bridge URL is not set — open Workbench → Configuration → Mikiedi and fill in Bridge URL, then Save and apply")
  end
  -- v0.3: every call carries the per-tab session id; state-changing ops also
  -- carry the retention policy composed from the configuration.
  payload.session = MIKIEDI_SESSION
  if STATE_CHANGING_OPS[payload.op] then
    payload.retention = mikiedi.retention()
  end
  local headers = { ["Content-Type"] = "application/json" }
  if token ~= "" then
    headers["Authorization"] = "Bearer " .. token
  end
  local resp = net.proxyFetch(url, { method = "POST", headers = headers, body = payload })
  if resp == nil then
    pcall(mikiedi.append_log, payload.op or "?", mikiedi.main_slug(payload), "error", "the bridge returned no response")
    error("Mikiedi: the bridge returned no response")
  end
  if resp.status ~= 200 then
    local detail = ""
    if type(resp.body) == "table" and resp.body.error ~= nil then
      detail = tostring(resp.body.error)
    else
      detail = tostring(resp.body)
    end
    pcall(mikiedi.append_log, payload.op or "?", mikiedi.main_slug(payload), "error", "HTTP " .. tostring(resp.status) .. ": " .. detail)
    error("Mikiedi: bridge error (HTTP " .. tostring(resp.status) .. "): " .. detail)
  end
  if type(resp.body) == "table" and resp.body.ok == false then
    pcall(mikiedi.append_log, payload.op or "?", mikiedi.main_slug(payload), "error", tostring(resp.body.error))
    error("Mikiedi: " .. tostring(resp.body.error))
  end
  -- Success: record the outcome on the Mikiedi/Log page.
  local outcome = "ok"
  local detail = ""
  if type(resp.body.result) == "table" and type(resp.body.result.pages) == "table" and type(resp.body.result.pages[1]) == "table" then
    local r = resp.body.result.pages[1]
    outcome = tostring(r.status or "ok")
    detail = tostring(r.detail or table.concat(r.issues or {}, "; "))
  end
  pcall(mikiedi.append_log, payload.op or "?", mikiedi.main_slug(payload), outcome, detail)
  return resp.body
end

mikiedi.describe_refresh = function(refresh)
  if refresh == nil then return "" end
  if refresh.ok then return " Index refresh: done." end
  return " Retrieval refresh is PENDING — run `assistant memory v3 rebuild-index` on the Cadet box."
end

mikiedi.conflict_page = function(slug, verdict, sbContent)
  local pageName = "Mikiedi/Conflicts/" .. slug
  local lines = {
    "A publication conflict was recorded for **" .. slug .. "**.",
    "",
    verdict.detail or "Cadet's copy and this space's copy both changed.",
    "",
    "## Cadet version",
    "",
    "```markdown",
    verdict.cadetContent or "(unavailable)",
    "```",
    "",
    "## SilverBullet version (rejected)",
    "",
    "```markdown",
    sbContent or "(not supplied)",
    "```",
    "",
    "Resolve from here: edit your copy to the intended final state and publish again " ..
      "(the bridge will record a fresh conflict if Cadet changed), or run **Mikiedi: Resolve conflict** " ..
      "to keep either side explicitly, or resolve on the Cadet side with op `resolve`.",
  }
  space.writePage(pageName, table.concat(lines, "\n"))
  return pageName
end

mikiedi.publish_pages = function(entries)
  -- entries: list of {slug=..., content=...}
  local payload = { op = "publish", pages = {} }
  for _, e in ipairs(entries) do
    table.insert(payload.pages, { slug = e.slug, content = e.content })
  end
  local rf = mikiedi.refresh_flag()
  if rf ~= nil then payload.refresh = rf end
  local resp = mikiedi.call(payload)
  local out = {}
  for _, r in ipairs(resp.result.pages) do
    local line = r.slug .. ": " .. r.status
    if r.status == "conflict" or r.status == "error" then
      line = line .. " — " .. (r.detail or table.concat(r.issues or {}, "; "))
    end
    table.insert(out, line)
  end
  local summary = table.concat(out, "\n")
  local suffix = mikiedi.describe_refresh(resp.result.refresh)
  if #resp.result.pages == 1 then
    local r = resp.result.pages[1]
    if r.status == "published" then
      editor.flashNotification("Published " .. r.slug .. " to Cadet memory." .. suffix)
    elseif r.status == "adopt-required" then
      if editor.confirm("This page already exists in Cadet memory but the bridge has no baseline for it yet.\n\nRecord the current Cadet version as the baseline (adopt), then publish your edit?", { destructive = false }) then
        local adopt = mikiedi.call({ op = "adopt", slugs = { r.slug } })
        local a = adopt.result.pages[1]
        if a.status == "unchanged" then
          local retry = mikiedi.call({ op = "publish", pages = { { slug = r.slug, content = entries[1].content } } })
          local rr = retry.result.pages[1]
          if rr.status == "published" then
            editor.flashNotification("Adopted baseline and published " .. r.slug .. "." .. mikiedi.describe_refresh(retry.result.refresh))
          else
            editor.alert("Mikiedi: adopt succeeded but publish still returned " .. rr.status .. ": " .. tostring(rr.detail))
          end
        else
          editor.alert("Mikiedi: adopt failed: " .. tostring(a.detail))
        end
      end
    elseif r.status == "conflict" then
      if editor.confirm("Cadet changed this page since your last sync. Open the conflict page with both versions?", { destructive = false }) then
        local cp = mikiedi.conflict_page(r.slug, r, entries[1].content)
        editor.flashNotification("Conflict recorded: " .. cp)
      else
        editor.flashNotification("Conflict recorded for " .. r.slug .. " — nothing was written to Cadet.", "warning")
      end
    elseif r.status == "stale-editor" then
      if editor.confirm("Another editor session (likely another SilverBullet tab) published this page very recently.\n\n" .. tostring(r.detail) .. "\n\nRefresh this page from Cadet now?", { destructive = false }) then
        local pr = mikiedi.call({ op = "page", slug = r.slug })
        if pr.result.content ~= nil then
          space.writePage(r.slug, pr.result.content)
          editor.flashNotification("Mikiedi: '" .. r.slug .. "' refreshed from Cadet.")
        end
      else
        editor.flashNotification("Nothing was written; your copy is unchanged locally.", "warning")
      end
    else
      editor.alert("Mikiedi publish result:\n" .. summary)
    end
  else
    editor.flashNotification("Mikiedi published " .. #entries .. " pages." .. suffix)
  end
end

command.define {
  name = "Mikiedi: Publish current page",
  run = function()
    local ok, err = pcall(function()
      local name = editor.getCurrentPage()
      if mikiedi.is_excluded(name) then
        editor.alert("Mikiedi: library/config pages (Library/*, CONFIG, Mikiedi/*) are never published.")
        return
      end
      local valid, why = mikiedi.check_slug(name)
      if not valid then
        editor.alert(why)
        return
      end
      local text = editor.getText()
      if text:match("^%-%-%-") == nil then
        if editor.confirm("This page has no frontmatter. Prepend a Mikiedi scaffold (title, slug, empty tags and links)?") then
          text = table.concat({ "---", "title: " .. name, "slug: " .. name, "tags:", "links:", "---", "", text }, "\n")
          space.writePage(name, text)
        end
      end
      -- Rename guard: a stale frontmatter slug after a rename would silently
      -- publish under a different identity than the page says it is.
      local fm = text:match("^%-%-%-\n(.-)\n%-%-%-")
      if fm then
        local declared = fm:match("^slug:%s*(%S+)")
        if declared and declared ~= name then
          if not editor.confirm("Frontmatter says slug: " .. declared .. ", but this page is '" .. name .. "'. Cadet identity comes from the page NAME ('" .. name .. "'). If you renamed this page, consider that cross-references in Cadet still point at the old slug.\n\nPublish anyway under '" .. name .. "'?") then
            return
          end
        end
      end
      mikiedi.publish_pages({ { slug = name, content = text } })
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Publish pages…",
  run = function()
    local ok, err = pcall(function()
      local options = {}
      for _, meta in ipairs(space.listPages()) do
        local name = meta.name or meta
        if not mikiedi.is_excluded(name) then
          local valid = mikiedi.check_slug(name)
          if valid then
            table.insert(options, { name = name, value = name })
          end
        end
      end
      if #options == 0 then
        editor.alert("Mikiedi: no publishable pages found (all pages are library/config pages or have invalid slugs).")
        return
      end
      local picked = editor.filterBox("Publish page:", options, "Only pages with valid Cadet slugs are listed")
      if picked == nil then return end
      local text = space.readPage(picked.value)
      mikiedi.publish_pages({ { slug = picked.value, content = text } })
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Refresh from Cadet",
  run = function()
    local ok, err = pcall(function()
      local name = editor.getCurrentPage()
      if mikiedi.is_excluded(name) then
        editor.alert("Mikiedi: library/config pages are not part of the bridge.")
        return
      end
      local valid, why = mikiedi.check_slug(name)
      if not valid then
        editor.alert(why)
        return
      end
      local text = editor.getText()
      local resp = mikiedi.call({ op = "sync", slug = name, content = text })
      local v = resp.result
      if v.action == "current" then
        editor.flashNotification("Mikiedi: this page matches Cadet memory.")
      elseif v.action == "update" then
        if editor.confirm("Cadet has a newer version of this page. Replace your copy with Cadet's version?", { destructive = true }) then
          space.writePage(name, v.cadetContent)
          editor.flashNotification("Mikiedi: page updated from Cadet.")
        end
      elseif v.action == "publish-from-editor" then
        if editor.confirm("Your copy has edits and Cadet is unchanged since your last publish. Publish now?", { destructive = false }) then
          mikiedi.publish_pages({ { slug = name, content = text } })
        end
      elseif v.action == "deleted-in-cadet" then
        if editor.confirm("This page no longer exists in Cadet memory. Delete it in SilverBullet too?\n\n" .. tostring(v.detail), { destructive = true }) then
          space.deletePage(name)
          editor.flashNotification("Mikiedi: page deleted from the space.")
        end
      elseif v.action == "conflict" then
        local cp = mikiedi.conflict_page(name, v, text)
        editor.flashNotification("Conflict recorded: " .. cp, "warning")
      else
        editor.alert("Mikiedi: unexpected sync verdict: " .. tostring(v.action))
      end
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Pull all pages from Cadet",
  run = function()
    local ok, err = pcall(function()
      local url, token, opts = mikiedi.settings()
      local resp = mikiedi.call({ op = "fetchAll" })
      local pages = resp.result.pages
      local candidates = {}
      for _, p in ipairs(pages) do
        if not mikiedi.excluded_from_pull(p.slug, opts.pullExclusions) then
          table.insert(candidates, p)
        end
      end
      if #candidates == 0 then
        editor.alert("Mikiedi: Cadet memory has no pullable pages (or all are excluded by the pull-exclusions setting).")
        return
      end
      if not editor.confirm("Pull " .. #candidates .. " pages from Cadet memory into this space?\n\nPages that do not exist here yet are written as-is. Pages that already exist here with DIFFERENT content are left untouched (your local edits win locally); they are listed in the report so you can decide per page with 'Mikiedi: Refresh from Cadet'.") then
        return
      end
      local written, same, kept = {}, {}, {}
      for _, p in ipairs(candidates) do
        local exists, current = pcall(space.readPage, p.slug)
        if exists and type(current) == "string" then
          if current == p.content then
            table.insert(same, p.slug)
          else
            table.insert(kept, p.slug)
          end
        else
          space.writePage(p.slug, p.content)
          table.insert(written, p.slug)
        end
      end
      local lines = {
        "# Mikiedi pull report",
        "",
        "Pulled from Cadet memory at " .. resp.result.generatedAt .. ".",
        "",
        "- Written into this space: **" .. #written .. "**",
        "- Already identical: **" .. #same .. "**",
        "- Kept local edits (Cadet copy differs — refresh per page to overwrite): **" .. #kept .. "**",
        "",
      }
      if #kept > 0 then
        table.insert(lines, "## Pages with local edits (NOT overwritten)")
        table.insert(lines, "")
        for _, s in ipairs(kept) do table.insert(lines, "- " .. s) end
        table.insert(lines, "")
      end
      if #written > 0 then
        table.insert(lines, "## Pages written")
        table.insert(lines, "")
        for _, s in ipairs(written) do table.insert(lines, "- " .. s) end
        table.insert(lines, "")
      end
      space.writePage("Mikiedi/Pull", table.concat(lines, "\n"))
      editor.flashNotification("Mikiedi: pulled " .. #written .. " new, " .. #same .. " identical, " .. #kept .. " kept local. Report: Mikiedi/Pull")
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Delete page from Cadet",
  run = function()
    local ok, err = pcall(function()
      local name = editor.getCurrentPage()
      if mikiedi.is_excluded(name) then
        editor.alert("Mikiedi: library/config pages are not part of the bridge.")
        return
      end
      local valid, why = mikiedi.check_slug(name)
      if not valid then
        editor.alert(why)
        return
      end
      if not editor.confirm("DELETE '" .. name .. "' from Cadet memory?\n\nThis is guarded: it only goes through if Cadet's page still matches what the bridge last saw, and the previous version is snapshotted on the Cadet side before deletion. The SilverBullet copy is asked about separately.", { destructive = true }) then
        return
      end
      local pageResp = mikiedi.call({ op = "page", slug = name })
      local hash = pageResp.result.hash
      if hash == nil then
        if editor.confirm("This page does not exist in Cadet memory. Delete the SilverBullet copy?", { destructive = true }) then
          space.deletePage(name)
          editor.flashNotification("Mikiedi: local copy deleted (nothing existed in Cadet).")
        end
        return
      end
      local payload = { op = "delete", slug = name, baseHash = hash }
      local rf = mikiedi.refresh_flag()
      if rf ~= nil then payload.refresh = rf end
      local resp = mikiedi.call(payload)
      local r = resp.result.pages[1]
      if r.status == "deleted" then
        editor.flashNotification("Mikiedi: '" .. name .. "' deleted from Cadet memory." .. mikiedi.describe_refresh(resp.result.refresh))
        if editor.confirm("Also delete the SilverBullet copy of '" .. name .. "'?", { destructive = true }) then
          space.deletePage(name)
        end
      elseif r.status == "conflict" then
        local pr = mikiedi.call({ op = "page", slug = name })
        r.cadetContent = pr.result.content
        local cp = mikiedi.conflict_page(name, r, editor.getText())
        editor.alert("Mikiedi: Cadet's copy changed since the bridge last saw it — deletion refused, nothing was deleted. Conflict page: " .. cp)
      else
        editor.alert("Mikiedi delete result: " .. r.status .. " — " .. tostring(r.detail))
      end
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Resolve conflict",
  run = function()
    local ok, err = pcall(function()
      local status = mikiedi.call({ op = "status" }).result
      local conflicts = status.conflicts or {}
      if #conflicts == 0 then
        editor.flashNotification("Mikiedi: no unresolved conflicts.")
        return
      end
      local current = editor.getCurrentPage()
      local slug = current:match("^Mikiedi/Conflicts/(.+)$")
      if slug == nil then
        if #conflicts == 1 then
          slug = conflicts[1].slug
        else
          local options = {}
          for _, c in ipairs(conflicts) do
            table.insert(options, { name = c.slug, value = c.slug })
          end
          local picked = editor.filterBox("Resolve which conflict?", options, "Unresolved conflicts recorded by the bridge")
          if picked == nil then return end
          slug = picked.value
        end
      end
      local known = false
      for _, c in ipairs(conflicts) do
        if c.slug == slug then known = true end
      end
      if not known then
        editor.alert("Mikiedi: no unresolved conflict recorded for '" .. slug .. "'.")
        return
      end
      local picked = editor.filterBox("Resolve '" .. slug .. "':", {
        { name = "Keep Cadet's version (discard this space's copy)", value = "keep-cadet" },
        { name = "Publish this space's version (overwrite Cadet)", value = "publish-sb" },
      }, "The other version is preserved in the conflict page either way")
      if picked == nil then return end
      local payload = { op = "resolve", slug = slug, action = picked.value }
      if picked.value == "publish-sb" then
        local okr, sbText = pcall(space.readPage, slug)
        if not okr or type(sbText) ~= "string" then
          editor.alert("Mikiedi: no SilverBullet copy of '" .. slug .. "' found to publish.")
          return
        end
        payload.content = sbText
      end
      local rf = mikiedi.refresh_flag()
      if rf ~= nil then payload.refresh = rf end
      local resp = mikiedi.call(payload)
      local r = resp.result.pages[1]
      if r.status ~= "resolved" then
        editor.alert("Mikiedi: resolve returned '" .. tostring(r.status) .. "': " .. tostring(r.detail))
        return
      end
      if picked.value == "keep-cadet" then
        local pr = mikiedi.call({ op = "page", slug = slug })
        if pr.result.content ~= nil then
          space.writePage(slug, pr.result.content)
        end
        editor.flashNotification("Mikiedi: kept Cadet's version of '" .. slug .. "' and updated the local copy." .. mikiedi.describe_refresh(resp.result.refresh))
      else
        editor.flashNotification("Mikiedi: published this space's version of '" .. slug .. "'." .. mikiedi.describe_refresh(resp.result.refresh))
      end
      pcall(space.deletePage, "Mikiedi/Conflicts/" .. slug)
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Status",
  run = function()
    local ok, err = pcall(function()
      local status = mikiedi.call({ op = "status" }).result
      local pages = mikiedi.call({ op = "pages" }).result.pages
      local lines = {
        "# Mikiedi status",
        "",
        "Bridge version: **" .. status.version .. "** · Concept pages: **" .. status.pageCount .. "**",
        "",
        "Concepts directory: `" .. status.conceptsDir .. "`" .. (status.conceptsDirIsDefault and " (Cadet default)" or " (OVERRIDE — not the default memory store)"),
        "",
      }
      if status.pendingRefresh then
        table.insert(lines, "**Retrieval refresh is PENDING.** Run `assistant memory v3 rebuild-index` on the Cadet box, or Mikiedi: refresh via the bridge's `refresh` op.")
        table.insert(lines, "")
      end
      if status.lastRefresh then
        table.insert(lines, "Last refresh: " .. status.lastRefresh.at .. " — " .. (status.lastRefresh.ok and "ok" or "FAILED") .. " · " .. tostring(status.lastRefresh.detail))
        table.insert(lines, "")
      end
      if #status.conflicts > 0 then
        table.insert(lines, "## Unresolved conflicts (" .. #status.conflicts .. ")")
        table.insert(lines, "")
        for _, c in ipairs(status.conflicts) do
          table.insert(lines, "- **" .. c.slug .. "** — " .. c.at)
        end
        table.insert(lines, "")
      end
      table.insert(lines, "## Pages")
      table.insert(lines, "")
      table.insert(lines, "| Slug | Changed | Last published | Conflict |")
      table.insert(lines, "| --- | --- | --- | --- |")
      for _, p in ipairs(pages) do
        table.insert(lines, "| " .. p.slug .. " | " .. p.mtime .. " | " .. tostring(p.lastPublishedAt or "—") .. " | " .. tostring(p.conflict or "—") .. " |")
      end
      table.insert(lines, "")
      table.insert(lines, "Recent bridge journal:")
      table.insert(lines, "")
      table.insert(lines, "```")
      for _, j in ipairs(status.journalTail or {}) do
        table.insert(lines, j.at .. " " .. j.op .. " " .. j.slug .. " " .. j.outcome)
      end
      table.insert(lines, "```")
      space.writePage("Mikiedi/Status", table.concat(lines, "\n"))
      editor.flashNotification("Mikiedi status written to Mikiedi/Status")
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Adopt Cadet state",
  run = function()
    local ok, err = pcall(function()
      if not editor.confirm("Record the CURRENT Cadet versions of all pages as the bridge baseline?\n\nThis changes no pages. It tells the bridge what your editor has last seen, so future publishes are guarded against exactly those versions. Do this once after first install, or after you know the whole memory store changed outside the bridge.", { destructive = true }) then
        return
      end
      local resp = mikiedi.call({ op = "adopt", slugs = "all" })
      editor.flashNotification("Mikiedi: adopted " .. #resp.result.pages .. " pages as baseline.")
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

-- ---------------------------------------------------------------------------
-- v0.3: version history panel, undo/redo, retention pruning
-- ---------------------------------------------------------------------------

local MIKIEDI_REPO = "https://github.com/wyattkuhns/Mikiedi"

mikiedi.json = function(tbl)
  local ok, out = pcall(js.stringify, tbl)
  if ok then return out:gsub("<", "\\u003c") end
  return "{}"
end

-- Ensures the Mikiedi/Help page exists, then returns its name.
mikiedi.ensure_help = function()
  local name = "Mikiedi/Help"
  local ok, existing = pcall(space.readPage, name)
  if not (ok and type(existing) == "string" and #existing > 0) then
    local body = {
      "# Mikiedi help",
      "",
      "Mikiedi is the bridge between this SilverBullet space and a Cadet assistant's memory store.",
      "Pages you publish here are validated, revision-guarded (CAS), snapshotted, journaled, and versioned",
      "on the Cadet side. Conflicts are preserved, never auto-resolved.",
      "",
      "## Commands",
      "",
      "- **Mikiedi: Pull all pages from Cadet** — fetch the whole store into this space (local edits never overwritten).",
      "- **Mikiedi: Publish current page / Publish pages…** — validated, CAS-guarded publish.",
      "- **Mikiedi: Refresh from Cadet** — pull the canonical version with conflict safety.",
      "- **Mikiedi: Delete page from Cadet** — CAS-guarded deletion, pre-image kept.",
      "- **Mikiedi: Resolve conflict** — keep Cadet's or publish this space's version.",
      "- **Mikiedi: Show panel** — the log/version panel: recent operations with timestamps,",
      "  git-style diffs between versions, undo/redo, click-through to pages.",
      "- **Mikiedi: Undo current page / Redo current page** — step the Cadet page back/forward through recent states.",
      "- **Mikiedi: Apply retention now** — prune the Cadet-side log and versions per the configured retention.",
      "- **Mikiedi: Status / Adopt Cadet state** — sync diagnostics and baseline recording.",
      "",
      "## Retention settings",
      "",
      "Workbench → Configuration → Mikiedi: separate retention for the **log** (the operation journal) and",
      "**versions** (the full page copies behind diffs and undo/redo). Each takes an amount plus a unit —",
      "seconds, minutes, hours, days, years — or `forever` (keep everything) / `never`.",
      "`never` on the log stops recording new entries; `never` on versions disables undo/redo.",
      "",
      "## Multiple tabs / sessions",
      "",
      "If two SilverBullet tabs have the same page open, publishing from a stale tab is refused with a",
      "'refresh first' advisory inside a short window after the other tab's publish. Nothing is overwritten",
      "silently; refresh and publish again.",
      "",
      "Repo: " .. MIKIEDI_REPO,
    }
    space.writePage(name, table.concat(body, "\n"))
  end
  return name
end

command.define {
  name = "Mikiedi: Show panel",
  run = function()
    local ok, err = pcall(function()
      local name = editor.getCurrentPage()
      local slug = nil
      if not mikiedi.is_excluded(name) then
        local valid = mikiedi.check_slug(name)
        if valid then slug = name end
      end

      local entries = {}
      local versions, currentHash = {}, nil
      local undoCount, redoCount = 0, 0
      local diffs = {}

      local okL, logResp = pcall(mikiedi.call, { op = "log", count = 50 })
      if okL and logResp.result and logResp.result.entries then entries = logResp.result.entries end

      if slug ~= nil then
        local okV, vResp = pcall(mikiedi.call, { op = "versions", slug = slug })
        if okV and vResp.result and vResp.result.versions then
          versions = vResp.result.versions
          currentHash = vResp.result.currentHash
          undoCount = vResp.result.undoCount or 0
          redoCount = vResp.result.redoCount or 0
          -- Precompute diffs: consecutive pairs and each recent version vs
          -- the current state, capped at the 10 most recent versions.
          local start = math.max(1, #versions - 9)
          for i = start, #versions do
            local from = versions[i]
            local target = "current"
            local okD, dResp = pcall(mikiedi.call, { op = "diff", slug = slug, from = from.hash or "", to = target })
            if okD and dResp.result and dResp.result.hunks then
              table.insert(diffs, { from = from.hash, to = "current", label = "v" .. i .. " → current", hunks = dResp.result.hunks })
            end
            if i > start then
              local okD2, d2 = pcall(mikiedi.call, { op = "diff", slug = slug, from = versions[i - 1].hash or "", to = from.hash or "" })
              if okD2 and d2.result and d2.result.hunks then
                table.insert(diffs, { from = versions[i - 1].hash, to = from.hash, label = "v" .. (i - 1) .. " → v" .. i, hunks = d2.result.hunks })
              end
            end
          end
        end
      end

      local data = mikiedi.json({
        slug = slug,
        currentHash = currentHash,
        versions = versions,
        undoCount = undoCount,
        redoCount = redoCount,
        entries = entries,
        diffs = diffs,
        repo = MIKIEDI_REPO,
      })

      local html = [[
<style>
#mikiedi-root { font-family: var(--ui-font, sans-serif); font-size: 12px; padding: 6px; color: var(--color, #ccc); }
.mk-toolbar { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
.mk-toolbar button { cursor: pointer; }
.mk-info { border: 1px solid #555; border-radius: 4px; padding: 6px; margin-bottom: 6px; background: rgba(128,128,128,0.12); }
.mk-sect { font-weight: bold; margin: 8px 0 4px 0; border-bottom: 1px solid #555; padding-bottom: 2px; }
.mk-log { max-height: 200px; overflow-y: auto; }
.mk-log table { width: 100%; border-collapse: collapse; }
.mk-log td { padding: 1px 4px; border-bottom: 1px solid #333; vertical-align: top; font-size: 11px; }
.out-published { color: #7ad37a; } .out-created { color: #7ad37a; } .out-resolved { color: #7ad37a; }
.out-unchanged { color: #999; } .out-deleted { color: #d3a47a; }
.out-conflict { color: #e0b040; font-weight: bold; } .out-error { color: #e07070; font-weight: bold; }
.out-stale-editor { color: #e0b040; } .out-adopt-required { color: #e0b040; }
.mk-rows .mk-row { cursor: pointer; padding: 2px 4px; border-radius: 3px; }
.mk-rows .mk-row:hover { background: rgba(128,128,128,0.2); }
.mk-diff { font-family: var(--editor-font, monospace); font-size: 11px; max-height: 260px; overflow: auto; border: 1px solid #444; border-radius: 4px; }
.mk-diff .dl { white-space: pre-wrap; padding: 0 4px; }
.mk-diff .add { background: rgba(70,180,70,0.25); color: #9de09d; }
.mk-diff .del { background: rgba(220,80,80,0.22); color: #e09d9d; text-decoration: none; }
.mk-diff .ctx { color: #888; }
.mk-diff .hdr { color: #7aa7d3; padding: 1px 4px; border-top: 1px solid #333; background: rgba(128,128,128,0.08); }
.mk-btns { display: flex; gap: 4px; margin: 4px 0; }
.mk-btns button:disabled { opacity: 0.4; cursor: default; }
.mk-note { color: #999; font-size: 11px; }
</style>
<div id="mikiedi-root">
  <div class="mk-toolbar">
    <button data-act="config">Config</button>
    <button data-act="help">Help</button>
    <button data-act="issues">Issues</button>
    <button data-act="info">Info</button>
    <button data-act="refresh" title="Re-fetch log and versions">↻</button>
  </div>
  <div id="mk-info" hidden>
    <b>Mikiedi</b> — a memory wiki editor. This SilverBullet space is a validated,
    revision-guarded front-end for a Cadet assistant's memory store: publish, sync,
    resolve conflicts, and inspect history. Never published itself; Cadet's copy is the
    canonical one. <button data-act="repo">Open repo</button>
  </div>
  <div id="mk-versions" class="mk-sect"></div>
  <div id="mk-undo" class="mk-btns"></div>
  <div id="mk-diffsel" class="mk-note"></div>
  <div id="mk-diff" class="mk-diff"></div>
  <div class="mk-sect">Log</div>
  <div id="mk-log" class="mk-log"></div>
</div>
<script id="mk-data" type="application/json">]] .. data .. [[</script>
]]

      local script = [[
const raw = JSON.parse(document.getElementById("mk-data").textContent);
const data = raw && raw.stringKeys ? raw.stringKeys : raw; // SB Lua->JS wraps the top-level table
// Lua-built lists arrive as {1:..., 2:...} objects; normalize to real arrays.
const fixArr = (v) => {
  // SB serializes pure-Lua tables as {metatable, stringKeys, otherKeys, arrayPart}
  // wrappers; unwrap those before the numeric-key normalization (diffs is built
  // in Lua, while bridge-decoded lists arrive as plain JSON arrays).
  if (v && typeof v === "object" && !Array.isArray(v) && ("arrayPart" in v || "stringKeys" in v)) {
    const o = {};
    if (v.arrayPart) for (let i = 0; i < v.arrayPart.length; i++) o[i + 1] = v.arrayPart[i];
    if (v.stringKeys) for (const k of Object.keys(v.stringKeys)) o[k] = v.stringKeys[k];
    v = o;
  }
  if (Array.isArray(v)) return v.map(fixArr);
  if (v && typeof v === "object") {
    const ks = Object.keys(v);
    if (ks.length > 0 && ks.every((k, i) => k === String(i + 1))) return ks.map((k) => fixArr(v[k]));
    if (ks.length > 0 && ks.every((k, i) => k === String(i))) return ks.map((k) => fixArr(v[k]));
    const o = {};
    for (const k of ks) o[k] = fixArr(v[k]);
    return o;
  }
  return v;
};
for (const k of Object.keys(data)) data[k] = fixArr(data[k]);
const call = (name, ...args) => syscall(name, ...args);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const el = (id) => document.getElementById(id);

// --- toolbar ---
document.querySelectorAll(".mk-toolbar button").forEach((b) => {
  b.addEventListener("click", async () => {
    const act = b.dataset.act;
    if (act === "config") { await call("editor.invokeCommand", "Workbench: Configuration"); }
    else if (act === "help") { await call("editor.navigate", "Mikiedi/Help"); }
    else if (act === "issues") { await call("editor.openUrl", data.repo + "/issues"); }
    else if (act === "repo") { await call("editor.openUrl", data.repo); }
    else if (act === "info") { const i = el("mk-info"); i.hidden = !i.hidden; }
    else if (act === "refresh") { await call("editor.invokeCommand", "Mikiedi: Show panel"); }
  });
});

// --- log ---
const logTbody = [];
logTbody.push("<table>");
for (const e of (data.entries || []).slice().reverse()) {
  const det = esc(e.detail || "").slice(0, 80);
  logTbody.push("<tr class='mk-row' data-slug='" + esc(e.slug || "") + "'>" +
    "<td>" + esc((e.at || "").replace("T", " ").replace("Z", "")) + "</td>" +
    "<td>" + esc(e.op || "") + "</td>" +
    "<td>" + esc(e.slug || "") + "</td>" +
    "<td class='out-" + esc(e.outcome || "") + "'>" + esc(e.outcome || "") + "</td>" +
    "<td>" + det + "</td></tr>");
}
logTbody.push("</table>");
el("mk-log").innerHTML = logTbody.join("");
el("mk-log").addEventListener("click", (ev) => {
  const row = ev.target.closest("tr");
  const slug = row && row.dataset.slug;
  if (slug) call("editor.navigate", slug);
});

// --- versions + undo/redo ---
const versions = data.versions || [];
const vHead = el("mk-versions");
if (data.slug) {
  vHead.textContent = "Versions — " + data.slug;
} else {
  vHead.textContent = "Versions (open a publishable page to see its history)";
}
const rows = [];
rows.push("<div class='mk-rows'>");
versions.slice().reverse().forEach((v, idx) => {
  const realIdx = versions.length - 1 - idx;
  const cur = v.hash !== null && v.hash === data.currentHash ? " ·current" : "";
  rows.push("<div class='mk-row' data-hash='" + esc(v.hash || "") + "'><b>v" + realIdx + "</b> · " +
    esc((v.ts || "").replace("T", " ").slice(0, 19)) + " · " + esc(v.op || "") + "/" + esc(v.outcome || "") +
    (v.hash === null ? " · deleted" : "") + cur + "</div>");
});
if (versions.length === 0 && data.slug) {
  rows.push("<div class='mk-note'>No recorded versions yet (version retention may be 'never', or the page was never published from here).</div>");
}
rows.push("</div>");
const container = document.createElement("div");
container.innerHTML = rows.join("");
vHead.insertAdjacentElement("afterend", container);
container.addEventListener("click", (ev) => {
  const row = ev.target.closest(".mk-row");
  if (row && row.dataset.hash !== undefined && data.slug) call("editor.navigate", data.slug);
});

const undoBtn = document.createElement("button");
undoBtn.textContent = "Undo (" + (data.undoCount || 0) + ")";
undoBtn.disabled = !(data.undoCount > 0);
undoBtn.addEventListener("click", () => call("editor.invokeCommand", "Mikiedi: Undo current page"));
const redoBtn = document.createElement("button");
redoBtn.textContent = "Redo (" + (data.redoCount || 0) + ")";
redoBtn.disabled = !(data.redoCount > 0);
redoBtn.addEventListener("click", () => call("editor.invokeCommand", "Mikiedi: Redo current page"));
el("mk-undo").appendChild(undoBtn);
el("mk-undo").appendChild(redoBtn);

// --- diff viewer ---
const diffs = data.diffs || [];
const sel = document.createElement("select");
for (const d of diffs) {
  const o = document.createElement("option");
  o.value = d.label;
  o.textContent = d.label;
  sel.appendChild(o);
}
el("mk-diffsel").innerHTML = "";
el("mk-diffsel").appendChild(sel);
el("mk-diffsel").insertAdjacentHTML("beforeend", " <span>compare</span>");
const renderDiff = () => {
  const d = diffs.find((x) => x.label === sel.value);
  const out = [];
  if (!d) { el("mk-diff").innerHTML = "<div class='ctx'>No diffs available.</div>"; return; }
  out.push("<div class='hdr'>@@ " + esc(d.label) + " @@</div>");
  for (const h of d.hunks || []) {
    out.push("<div class='hdr'>@@ -" + h.aStart + " +" + h.bStart + " @@</div>");
    for (const l of h.lines || []) {
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      out.push("<div class='dl " + l.type + "'>" + sign + " " + esc(l.text) + "</div>");
    }
  }
  el("mk-diff").innerHTML = out.join("");
};
sel.addEventListener("change", renderDiff);
renderDiff();
]]

      editor.showPanel("rhs", "0 0 340px", html, script)
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

local function apply_undo_redo(label, op)
  local name = editor.getCurrentPage()
  if mikiedi.is_excluded(name) then
    editor.alert("Mikiedi: library/config pages are not part of the bridge.")
    return
  end
  local valid, why = mikiedi.check_slug(name)
  if not valid then
    editor.alert(why)
    return
  end
  if not editor.confirm(label .. " the Cadet copy of '" .. name .. "' to its previous state?\n\nThe local copy is replaced with the restored Cadet version (your unpublished local edits to this page would be lost).", { destructive = true }) then
    return
  end
  local resp = mikiedi.call({ op = op, slug = name })
  local r = resp.result.pages[1]
  if r.status == "published" then
    local pr = mikiedi.call({ op = "page", slug = name })
    if pr.result.content ~= nil then space.writePage(name, pr.result.content) end
    editor.flashNotification("Mikiedi: " .. label:lower() .. " applied to '" .. name .. "'." .. mikiedi.describe_refresh(resp.result.refresh))
  elseif r.status == "deleted" then
    if editor.confirm("The undo restored the state where this page was deleted in Cadet. Also delete the local copy?", { destructive = true }) then
      space.deletePage(name)
      editor.flashNotification("Mikiedi: '" .. name .. "' undone to deleted; local copy removed.")
    end
  else
    editor.alert("Mikiedi " .. op .. " result: " .. tostring(r.status) .. " — " .. tostring(r.detail))
    return
  end
end

command.define {
  name = "Mikiedi: Undo current page",
  run = function()
    local ok, err = pcall(function() apply_undo_redo("Undo", "undo") end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Redo current page",
  run = function()
    local ok, err = pcall(function() apply_undo_redo("Redo", "redo") end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Apply retention now",
  run = function()
    local ok, err = pcall(function()
      if not editor.confirm("Prune the Cadet-side log and version history now, per the configured retention?\n\nPruned journal lines are archived on the Cadet side (journal-archive.jsonl), never silently destroyed; pruned version content is removed for good.", { destructive = true }) then
        return
      end
      local resp = mikiedi.call({ op = "prune" })
      local r = resp.result
      editor.flashNotification("Mikiedi prune: journal lines archived " .. tostring(r.journalArchived or 0) ..
        (r.journalCleared and " (log cleared)" or "") ..
        ", versions removed " .. tostring(r.versionsRemoved or 0) .. ".")
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}

command.define {
  name = "Mikiedi: Open help",
  run = function()
    local ok, err = pcall(function()
      local name = mikiedi.ensure_help()
      editor.navigate(name)
    end)
    if not ok then editor.alert("Mikiedi error: " .. tostring(err)) end
  end,
}
```
