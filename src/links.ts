import { App, TFile, parseLinktext } from "obsidian";
import { SubpathInfo } from "./types";

export function buildSubpath(info: SubpathInfo): string {
  const parts: string[] = [];
  if (info.page) parts.push(`page=${info.page}`);
  if (info.annot) parts.push(`annot=${info.annot}`);
  if (info.heading) parts.push(`heading=${encodeURIComponent(info.heading)}`);
  return parts.length ? "#" + parts.join("&") : "";
}

export function parseSubpath(sub: string): SubpathInfo {
  const out: SubpathInfo = {};
  const s = sub.replace(/^#/, "");
  for (const part of s.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k === "page") {
      const n = parseInt(v, 10);
      if (n > 0) out.page = n;
    } else if (k === "annot") out.annot = v;
    else if (k === "heading") {
      try {
        out.heading = decodeURIComponent(v);
      } catch {
        out.heading = v;
      }
    }
  }
  return out;
}

export function sanitizeAlias(s: string, max = 50): string {
  const t = s.replace(/[\[\]|#^\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export interface Backlink {
  source: TFile;
  line: number;
  info: SubpathInfo;
  display: string;
}

export function collectBacklinks(app: App, pdf: TFile): Backlink[] {
  const out: Backlink[] = [];
  const resolved = app.metadataCache.resolvedLinks;
  for (const sourcePath of Object.keys(resolved)) {
    if (!resolved[sourcePath][pdf.path]) continue;
    const source = app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFile)) continue;
    const cache = app.metadataCache.getFileCache(source);
    if (!cache) continue;
    for (const l of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
      const { path, subpath } = parseLinktext(l.link);
      const dest = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
      if (dest?.path !== pdf.path) continue;
      out.push({
        source,
        line: l.position.start.line,
        info: parseSubpath(subpath),
        display: l.displayText || l.original,
      });
    }
  }
  return out;
}

export function linktextFromStored(link: string): string | null {
  const wiki = link.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
  if (wiki) return wiki[1];
  const md = link.match(/\]\(([^)]+)\)$/);
  if (md) {
    try {
      return decodeURI(md[1].replace(/^<|>$/g, ""));
    } catch {
      return md[1];
    }
  }
  return null;
}
