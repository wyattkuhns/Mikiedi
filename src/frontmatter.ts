/**
 * Conservative frontmatter validator for concept pages.
 *
 * SilverBullet authors write Markdown by hand, so the bridge validates the
 * YAML subset the memory corpus actually uses before anything is written,
 * and reports human-readable issues instead of accepting bytes that would
 * fail later in Cadet's own schema validation (or worse, parse differently).
 *
 * Supported subset:
 *   key: scalar            (optionally 'single' or "double" quoted)
 *   key:                   followed by  - item  list entries
 *   key: [a, b]            inline list (optionally quoted items)
 *
 * Everything else — block scalars, nested maps, anchors, tabs, duplicate
 * keys, unquoted ": " in values — is rejected with a specific message.
 */

export interface PageValidation {
  issues: string[];
  warnings: string[];
  frontmatter: Record<string, string | string[]> | null;
}

export function splitFrontmatter(content: string): {
  frontmatterLines: string[] | null;
  body: string;
  error: string | null;
} {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatterLines: null, body: content, error: "page does not start with a '---' frontmatter block" };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return {
        frontmatterLines: lines.slice(1, i),
        body: lines.slice(i + 1).join("\n"),
        error: null,
      };
    }
  }
  return { frontmatterLines: null, body: content, error: "frontmatter block is never closed (no second '---' line)" };
}

interface ParsedFrontmatter {
  values: Record<string, string | string[]>;
  issues: string[];
}

function checkScalar(raw: string, context: string, issues: string[]): string | null {
  const value = raw.trim();
  if (value === "") {
    issues.push(`${context}: empty value`);
    return null;
  }
  const q = value[0];
  if (q === '"' || q === "'") {
    if (value.length < 2 || value[value.length - 1] !== q) {
      issues.push(`${context}: quoted value is not terminated`);
      return null;
    }
    const inner = value.slice(1, -1);
    if (inner.includes(q) || inner.includes("\\")) {
      issues.push(`${context}: quoted values containing quote or backslash characters are not supported; rephrase the value`);
      return null;
    }
    if (inner.trim() === "") {
      issues.push(`${context}: empty value`);
      return null;
    }
    return inner;
  }
  if (value.startsWith("|") || value.startsWith(">")) {
    issues.push(`${context}: block scalars (| and >) are not supported by the bridge validator; use a quoted single-line value`);
    return null;
  }
  if (value.includes(": ")) {
    issues.push(`${context}: unquoted value contains ": " — wrap the value in quotes`);
    return null;
  }
  if (value.endsWith(":")) {
    issues.push(`${context}: unquoted value ends with ":" — wrap the value in quotes`);
    return null;
  }
  if (value.startsWith("#")) {
    issues.push(`${context}: value starts with '#' (parsed as a YAML comment) — wrap the value in quotes`);
    return null;
  }
  if (/^[-&*!%@`]/.test(value)) {
    issues.push(`${context}: value starts with a YAML indicator character ('${value[0]}') — wrap the value in quotes`);
    return null;
  }
  return value;
}

export function parseFrontmatter(frontmatterLines: string[]): ParsedFrontmatter {
  const values: Record<string, string | string[]> = {};
  const issues: string[] = [];
  let currentListKey: string | null = null;

  for (let i = 0; i < frontmatterLines.length; i++) {
    const line = frontmatterLines[i];
    if (line.includes("\t")) {
      issues.push(`frontmatter line ${i + 1}: tab characters are not allowed; use spaces`);
      continue;
    }
    if (line.trim() === "") continue;

    const listItem = line.match(/^\s+-\s?(.*)$/);
    if (listItem) {
      if (currentListKey === null) {
        issues.push(`frontmatter line ${i + 1}: list entry appears before any "key:" it belongs to`);
        continue;
      }
      const item = checkScalar(listItem[1], `frontmatter line ${i + 1} (list item)`, issues);
      if (item !== null) (values[currentListKey] as string[]).push(item);
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (!keyMatch) {
      issues.push(`frontmatter line ${i + 1}: expected "key: value" or a "- item" list entry, got: ${line.trim().slice(0, 60)}`);
      continue;
    }
    const key = keyMatch[1];
    if (key in values) {
      issues.push(`frontmatter: duplicate key "${key}"`);
      continue;
    }
    const raw = keyMatch[2];
    if (raw === "") {
      currentListKey = key;
      values[key] = [];
      continue;
    }
    currentListKey = null;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1).trim();
      const items: string[] = [];
      if (inner !== "") {
        for (const part of inner.split(",")) {
          const item = checkScalar(part, `frontmatter key "${key}" (inline list)`, issues);
          if (item !== null) items.push(item);
        }
      }
      values[key] = items;
      continue;
    }
    const scalar = checkScalar(raw, `frontmatter key "${key}"`, issues);
    if (scalar !== null) values[key] = scalar;
  }
  return { values, issues };
}

/** Full validation of a staged page against Cadet's concept-page rules. */
export function validatePageContent(content: string, slug: string): PageValidation {
  const issues: string[] = [];
  const warnings: string[] = [];

  if (content.length === 0) {
    return { issues: ["page is empty (zero bytes)"], warnings, frontmatter: null };
  }
  const split = splitFrontmatter(content);
  if (split.error) {
    return { issues: [split.error], warnings, frontmatter: null };
  }
  const parsed = parseFrontmatter(split.frontmatterLines!);
  issues.push(...parsed.issues);

  if (split.body.trim() === "") {
    issues.push("page body is empty (frontmatter only)");
  }
  const fm = parsed.values;
  if (fm.slug !== undefined && fm.slug !== slug) {
    issues.push(`frontmatter slug "${fm.slug}" does not match the page slug "${slug}"`);
  }
  if (fm.slug === undefined) {
    warnings.push("frontmatter has no slug key (the filename provides it, but the memory corpus convention includes one)");
  }
  for (const key of ["tags", "links"]) {
    if (fm[key] !== undefined && !Array.isArray(fm[key])) {
      issues.push(`frontmatter "${key}" must be a YAML list (one entry per "- item" line), not a plain string`);
    }
  }
  if (fm.links !== undefined && Array.isArray(fm.links)) {
    for (const link of fm.links as string[]) {
      if (link.trim() === "") issues.push('frontmatter "links" contains an empty entry');
    }
  }
  return { issues, warnings, frontmatter: issues.length === 0 ? fm : null };
}
