---
name: Library/wyattkuhns/Mikiedi
tags:
  - meta/library
description: Mikiedi (Memory Wiki Editor) — publish, sync, and manage Cadet memory pages from SilverBullet
---

Mikiedi connects this SilverBullet space to a Cadet assistant's memory store through the Mikiedi bridge plugin (installed on the Cadet side). Pages published from here are validated, revision-guarded (CAS), snapshotted, and journaled before they reach Cadet memory; conflicts are preserved, never auto-resolved.

**Settings** live in the Workbench → **Configuration** tab, under the **Mikiedi** category (Bridge URL + Bridge token). They are saved to `Library/Config` and survive reloads.

If your SilverBullet build has no Mikiedi category there, create a `Mikiedi/Settings` page with two lines instead:

```
bridgeUrl: https://your-assistant.example.com/webhooks/plugins/mikiedi/bridge
bridgeToken: the-token-from-plugin-setup
```

When both are set, the Configuration values win — the settings page is only read when the Configuration entries are empty.

Commands (command palette):

| Command | What it does |
| --- | --- |
| `Mikiedi: Pull all pages from Cadet` | Fetch the whole memory store into this space (real slugs); local edits are never overwritten |
| `Mikiedi: Publish current page` | Validates and publishes this page into Cadet memory |
| `Mikiedi: Publish pages…` | Pick a page to publish |
| `Mikiedi: Refresh from Cadet` | Pull the canonical version of this page, with conflict safety |
| `Mikiedi: Delete page from Cadet` | CAS-guarded deletion of this page from Cadet memory, with confirmations |
| `Mikiedi: Resolve conflict` | Keep Cadet's version or publish this space's version for a recorded conflict |
| `Mikiedi: Status` | Write a `Mikiedi/Status` page: sync state, conflicts, refresh state |
| `Mikiedi: Adopt Cadet state` | Record baselines for pages that already exist in Cadet memory |

Library pages (`Library/…`), the `CONFIG` page, `Mikiedi/Settings`, and other `Mikiedi/…` pages are never published.

```space-lua
-- priority: 40
-- Mikiedi — Memory Wiki Editor. Publishes SilverBullet pages into Cadet
-- memory through the bridge plugin's ingress route. See the repo README
-- for the full conflict model and recovery guide.

-- Schema registration is best-effort: config.define* are pcall-guarded so the
-- library still loads on SB builds without the configuration schema API.
-- The settings page below is the fallback path for those builds.
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
        description = "Full URL of the bridge ingress route. A Mikiedi/Settings page is read as a fallback when this is empty.",
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
  end
end)

local mikiedi = {}

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
  if url == "" then
    -- Universal fallback: the Mikiedi/Settings page, two "key: value" lines.
    local ok, text = pcall(space.readPage, "Mikiedi/Settings")
    if ok and type(text) == "string" then
      url = text:match("bridgeUrl%s*:%s*(%S+)") or ""
      token = text:match("bridgeToken%s*:%s*(%S+)") or ""
    end
  end
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

mikiedi.call = function(payload)
  local url, token = mikiedi.settings()
  if url == "" then
    error("Mikiedi: bridge URL is not set — open Workbench → Configuration → Mikiedi and fill in Bridge URL (or set bridgeUrl in the Mikiedi/Settings page)")
  end
  local headers = { ["Content-Type"] = "application/json" }
  if token ~= "" then
    headers["Authorization"] = "Bearer " .. token
  end
  local resp = net.proxyFetch(url, { method = "POST", headers = headers, body = payload })
  if resp == nil then
    error("Mikiedi: the bridge returned no response")
  end
  if resp.status ~= 200 then
    local detail = ""
    if type(resp.body) == "table" and resp.body.error ~= nil then
      detail = tostring(resp.body.error)
    else
      detail = tostring(resp.body)
    end
    error("Mikiedi: bridge error (HTTP " .. tostring(resp.status) .. "): " .. detail)
  end
  if type(resp.body) == "table" and resp.body.ok == false then
    error("Mikiedi: " .. tostring(resp.body.error))
  end
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
```
