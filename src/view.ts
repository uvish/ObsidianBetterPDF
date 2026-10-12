import {
  FileView,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
  debounce,
  loadPdfJs,
  normalizePath,
  setIcon,
} from "obsidian";
import type BetterPdfPlugin from "./main";
import { AnnotationStore } from "./store";
import { Backlink, parseSubpath, sanitizeAlias } from "./links";
import { pickNote } from "./modals";
import {
  AnnotType,
  Annotation,
  CSS_UNITS,
  OutlineNode,
  Rect,
  ScrollMode,
  SpreadMode,
  VIEW_TYPE,
  ZoomMode,
  newId,
} from "./types";

const PAD = 16;
const GAP = 10;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const MAX_CANVAS_PIXELS = 16_000_000;

type SideTab = "outline" | "annotations" | "links";

interface PageState {
  token: number;
  busy: boolean;
  done: boolean;
  task: any;
}

interface Row {
  el: HTMLElement;
  pages: number[];
}

interface PxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class BetterPdfView extends FileView {
  private pdf: any = null;
  private numPages = 0;
  private sizes: { w: number; h: number }[] = [];
  private pageEls: HTMLElement[] = [];
  private pst: PageState[] = [];
  private rows: Row[] = [];
  private pageToRow: number[] = [];
  private spacerEl: HTMLElement | null = null;

  private scale = 1;
  private zoom: ZoomMode = "width";
  private scrollMode: ScrollMode = "continuous";
  private spreadMode: SpreadMode = "none";
  private currentPage = 1;
  private sidebarOpen = false;
  private sideTab: SideTab = "outline";
  private tool: "select" | "area" = "select";

  private store!: AnnotationStore;
  private outline: OutlineNode[] = [];
  private flatOutline: OutlineNode[] = [];
  private backlinks: Backlink[] = [];

  private ready = false;
  private loadToken = 0;
  private pendingSubpath: string | null = null;

  private rootEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private sidebarEl!: HTMLElement;
  private sideBodyEl!: HTMLElement;
  private scrollEl!: HTMLElement;
  private pagesEl!: HTMLElement;
  private selPopEl!: HTMLElement;
  private popEl: HTMLElement | null = null;
  private popOutside: ((e: MouseEvent) => void) | null = null;

  private pageInput!: HTMLInputElement;
  private totalEl!: HTMLElement;
  private zoomSelect!: HTMLSelectElement;
  private scrollSelect!: HTMLSelectElement;
  private spreadSelect!: HTMLSelectElement;
  private sidebarBtn!: HTMLElement;
  private areaBtn!: HTMLElement;
  private invertBtn!: HTMLElement;
  private tabBtns: Partial<Record<SideTab, HTMLElement>> = {};

  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private wheelFactor = 1;
  private scrollRaf = 0;

  private resizeSoon = debounce(() => this.onResizeCheck(), 150, true);
  private wheelZoomSoon = debounce(() => this.applyWheelZoom(), 120, true);
  private saveMemorySoon = debounce(() => this.saveMemory(), 700, true);

  constructor(leaf: WorkspaceLeaf, private plugin: BetterPdfPlugin) {
    super(leaf);
    this.navigation = true;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return this.file?.basename ?? "BetterPDF";
  }
  getIcon() {
    return "file-text";
  }
  canAcceptExtension(ext: string) {
    return ext === "pdf";
  }

  // ------------------------------------------------------------------ lifecycle

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("pdfs-host");
    this.rootEl = this.contentEl.createDiv({ cls: "pdfs-root", attr: { tabindex: "-1" } });
    this.toolbarEl = this.rootEl.createDiv({ cls: "pdfs-toolbar" });
    const body = this.rootEl.createDiv({ cls: "pdfs-body" });
    this.sidebarEl = body.createDiv({ cls: "pdfs-sidebar" });
    this.scrollEl = body.createDiv({ cls: "pdfs-scroll" });
    this.pagesEl = this.scrollEl.createDiv({ cls: "pdfs-pages" });

    this.buildToolbar();
    this.buildSidebarShell();
    this.buildSelectionPopup();

    this.io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const n = Number((en.target as HTMLElement).dataset.page);
          if (en.isIntersecting) void this.renderPage(n);
          else this.invalidate(n);
        }
      },
      { root: this.scrollEl, rootMargin: "800px 0px 800px 0px" }
    );
    this.ro = new ResizeObserver(() => this.resizeSoon());
    this.ro.observe(this.scrollEl);

    this.registerDomEvent(this.scrollEl, "scroll", () => {
      if (this.scrollRaf) return;
      this.scrollRaf = window.requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.onScroll();
      });
    });
    this.registerDomEvent(
      this.scrollEl,
      "wheel",
      (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.wheelFactor *= e.deltaY < 0 ? 1.08 : 1 / 1.08;
        this.wheelZoomSoon();
      },
      { passive: false }
    );
    this.registerDomEvent(this.scrollEl, "mouseup", () => window.setTimeout(() => this.updateSelectionPopup(), 10));
    this.registerDomEvent(this.scrollEl, "mousedown", (e: MouseEvent) => {
      this.rootEl.focus({ preventScroll: true });
      if (!(e.target as HTMLElement).closest(".pdfs-selpop")) this.hideSelPop();
    });
    this.registerDomEvent(this.pagesEl, "click", (e: MouseEvent) => this.onPageClick(e));
    this.registerDomEvent(this.pagesEl, "pointerdown", (e: PointerEvent) => this.onDrawStart(e));
    this.registerDomEvent(this.rootEl, "keydown", (e: KeyboardEvent) => this.onKey(e));
  }

  async onClose() {
    this.teardown();
    this.io?.disconnect();
    this.ro?.disconnect();
  }

  async onLoadFile(file: TFile) {
    this.teardown();
    this.ready = false;
    const token = ++this.loadToken;
    this.pagesEl.empty();
    this.pagesEl.createDiv({ cls: "pdfs-message", text: "Loading PDF…" });

    try {
      const pdfjs = await loadPdfJs();
      const data = await this.app.vault.readBinary(file);
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
      if (token !== this.loadToken) {
        void pdf.destroy();
        return;
      }
      this.pdf = pdf;
      this.numPages = pdf.numPages;
      const first = await pdf.getPage(1);
      const v = first.getViewport({ scale: 1 });
      this.sizes = Array.from({ length: this.numPages }, () => ({ w: v.width, h: v.height }));
      first.cleanup();
    } catch (e) {
      console.error("BetterPDF: failed to open", e);
      this.pagesEl.empty();
      this.pagesEl.createDiv({ cls: "pdfs-message", text: `Could not open this PDF: ${(e as Error).message ?? e}` });
      return;
    }

    this.store = new AnnotationStore(this.app, () => this.file?.path ?? file.path, (pages) => this.onStoreChange(pages));
    await this.store.load();
    if (token !== this.loadToken) return;

    const s = this.plugin.settings;
    const mem = s.rememberView ? s.memory[file.path] : undefined;
    this.zoom = mem?.zoom ?? s.defaultZoom;
    this.scrollMode = mem?.scroll ?? s.defaultScroll;
    this.spreadMode = mem?.spread ?? s.defaultSpread;
    this.currentPage = Math.min(Math.max(mem?.page ?? 1, 1), this.numPages);
    this.rootEl.toggleClass("pdfs-invert", s.invert);
    this.invertBtn.toggleClass("is-active", s.invert);
    this.totalEl.setText(`/ ${this.numPages}`);
    this.pageInput.max = String(this.numPages);

    this.buildPages();
    this.relayout(false);
    this.goToPage(this.currentPage);
    this.ready = true;

    void this.loadSizes(token);
    void this.loadOutline(token);
    this.refreshBacklinks();
    this.renderSidebar();

    if (this.pendingSubpath) {
      const sp = this.pendingSubpath;
      this.pendingSubpath = null;
      this.applySubpath(sp);
    }
  }

  async onUnloadFile(_file: TFile) {
    this.teardown();
  }

  private teardown() {
    this.loadToken++;
    this.closePopover();
    this.hideSelPop();
    if (this.store) void this.store.flush();
    this.saveMemory();
    this.io?.disconnect();
    for (const st of this.pst) st.task?.cancel?.();
    this.pst = [];
    this.pageEls = [];
    this.rows = [];
    if (this.pdf) {
      void this.pdf.destroy();
      this.pdf = null;
    }
    this.ready = false;
  }

  onResize() {
    this.resizeSoon();
  }

  setEphemeralState(state: any) {
    super.setEphemeralState(state);
    const sub = state?.subpath;
    if (typeof sub === "string" && sub) {
      if (this.ready) this.applySubpath(sub);
      else this.pendingSubpath = sub;
    }
  }

  // ------------------------------------------------------------------ toolbar

  private btn(parent: HTMLElement, icon: string, title: string, onClick: (e: MouseEvent) => void): HTMLElement {
    const b = parent.createEl("button", { cls: "clickable-icon pdfs-btn", attr: { "aria-label": title } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
    return b;
  }

  private buildToolbar() {
    const t = this.toolbarEl;
    const g1 = t.createDiv({ cls: "pdfs-group" });
    this.sidebarBtn = this.btn(g1, "panel-left", "Toggle sidebar", () => this.toggleSidebar());

    const g2 = t.createDiv({ cls: "pdfs-group" });
    this.btn(g2, "chevron-up", "Previous page", () => this.step(-1));
    this.pageInput = g2.createEl("input", { cls: "pdfs-page-input", attr: { type: "number", min: "1" } });
    this.pageInput.addEventListener("change", () => this.goToPage(parseInt(this.pageInput.value, 10) || 1));
    this.totalEl = g2.createSpan({ cls: "pdfs-total", text: "/ –" });
    this.btn(g2, "chevron-down", "Next page", () => this.step(1));

    const g3 = t.createDiv({ cls: "pdfs-group" });
    this.btn(g3, "zoom-out", "Zoom out", () => this.zoomBy(-1));
    this.zoomSelect = g3.createEl("select", { cls: "dropdown pdfs-select" });
    this.zoomSelect.createEl("option", { value: "width", text: "Fit width" });
    this.zoomSelect.createEl("option", { value: "page", text: "Fit page" });
    for (const z of ZOOM_PRESETS) this.zoomSelect.createEl("option", { value: String(z), text: `${Math.round(z * 100)}%` });
    this.zoomSelect.addEventListener("change", () => {
      const v = this.zoomSelect.value;
      this.setZoom(v === "width" || v === "page" ? v : Number(v));
    });
    this.btn(g3, "zoom-in", "Zoom in", () => this.zoomBy(1));

    const g4 = t.createDiv({ cls: "pdfs-group" });
    this.scrollSelect = g4.createEl("select", { cls: "dropdown pdfs-select", attr: { "aria-label": "Scrolling" } });
    this.scrollSelect.createEl("option", { value: "continuous", text: "Continuous" });
    this.scrollSelect.createEl("option", { value: "paged", text: "Page by page" });
    this.scrollSelect.addEventListener("change", () => {
      this.scrollMode = this.scrollSelect.value as ScrollMode;
      this.relayout();
      this.saveMemorySoon();
    });
    this.spreadSelect = g4.createEl("select", { cls: "dropdown pdfs-select", attr: { "aria-label": "Page layout" } });
    this.spreadSelect.createEl("option", { value: "none", text: "Single page" });
    this.spreadSelect.createEl("option", { value: "two", text: "Two pages" });
    this.spreadSelect.createEl("option", { value: "cover", text: "Two pages, cover alone" });
    this.spreadSelect.addEventListener("change", () => this.setSpread(this.spreadSelect.value as SpreadMode));

    const g5 = t.createDiv({ cls: "pdfs-group pdfs-group-right" });
    this.areaBtn = this.btn(g5, "box-select", "Area annotation (drag on a page)", () => this.toggleAreaTool());
    this.invertBtn = this.btn(g5, "moon", "Dark page colors", () => this.toggleInvert());
    this.btn(g5, "link", "Copy link to this page", () => this.copyPageLink());
  }

  private syncToolbar() {
    this.pageInput.value = String(this.currentPage);
    this.scrollSelect.value = this.scrollMode;
    this.spreadSelect.value = this.spreadMode;
    this.sidebarBtn.toggleClass("is-active", this.sidebarOpen);
    this.areaBtn.toggleClass("is-active", this.tool === "area");

    let value: string;
    if (this.zoom === "width" || this.zoom === "page") value = this.zoom;
    else value = String(this.zoom);
    if (!Array.from(this.zoomSelect.options).some((o) => o.value === value)) {
      this.zoomSelect.querySelector("option[data-custom]")?.remove();
      this.zoomSelect.createEl("option", {
        value,
        text: `${Math.round(Number(value) * 100)}%`,
        attr: { "data-custom": "1" },
      });
    }
    this.zoomSelect.value = value;
  }

  // ------------------------------------------------------------------ sidebar

  private buildSidebarShell() {
    const tabs = this.sidebarEl.createDiv({ cls: "pdfs-tabs" });
    const defs: [SideTab, string, string][] = [
      ["outline", "list", "Outline"],
      ["annotations", "highlighter", "Annotations"],
      ["links", "link-2", "Links"],
    ];
    for (const [id, icon, title] of defs) {
      this.tabBtns[id] = this.btn(tabs, icon, title, () => this.setSideTab(id));
    }
    this.sideBodyEl = this.sidebarEl.createDiv({ cls: "pdfs-side-body" });
  }

  toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
    this.rootEl.toggleClass("pdfs-sidebar-open", this.sidebarOpen);
    this.syncToolbar();
    this.renderSidebar();
    this.resizeSoon();
  }

  private setSideTab(tab: SideTab) {
    this.sideTab = tab;
    if (!this.sidebarOpen) this.toggleSidebar();
    else this.renderSidebar();
  }

  private renderSidebar() {
    if (!this.sidebarOpen || !this.ready) return;
    for (const [id, b] of Object.entries(this.tabBtns)) b?.toggleClass("is-active", id === this.sideTab);
    const el = this.sideBodyEl;
    el.empty();
    if (this.sideTab === "outline") this.renderOutline(el);
    else if (this.sideTab === "annotations") this.renderAnnotationList(el);
    else this.renderLinksTab(el);
  }

  private renderOutline(el: HTMLElement) {
    if (!this.outline.length) {
      el.createDiv({ cls: "pdfs-empty", text: "This PDF has no outline (table of contents)." });
      return;
    }
    const draw = (nodes: OutlineNode[], parent: HTMLElement, depth: number) => {
      for (const node of nodes) {
        const item = parent.createDiv({ cls: "pdfs-ol" });
        const row = item.createDiv({ cls: "pdfs-ol-row" });
        const hasKids = node.children.length > 0;
        const twisty = row.createSpan({ cls: "pdfs-ol-twisty" });
        if (hasKids) setIcon(twisty, "chevron-down");
        row.createSpan({ cls: "pdfs-ol-title", text: node.title });
        if (node.page) row.createSpan({ cls: "pdfs-ol-page", text: String(node.page) });
        const more = row.createSpan({ cls: "pdfs-ol-more clickable-icon" });
        setIcon(more, "more-horizontal");
        const kids = item.createDiv({ cls: "pdfs-ol-kids" });
        if (hasKids) {
          draw(node.children, kids, depth + 1);
          if (depth >= 1) {
            kids.addClass("is-collapsed");
            setIcon(twisty, "chevron-right");
          }
          twisty.addEventListener("click", (e) => {
            e.stopPropagation();
            kids.toggleClass("is-collapsed", !kids.hasClass("is-collapsed"));
            setIcon(twisty, kids.hasClass("is-collapsed") ? "chevron-right" : "chevron-down");
          });
        }
        row.style.paddingLeft = `${depth * 14 + 4}px`;
        row.addEventListener("click", () => node.page && this.goToPage(node.page));
        const menu = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (!node.page) return;
          const m = new Menu();
          this.addPageItems(m, node.page, node.title);
          m.showAtMouseEvent(e);
        };
        more.addEventListener("click", menu);
        row.addEventListener("contextmenu", menu);
      }
    };
    draw(this.outline, el, 0);
  }

  private renderAnnotationList(el: HTMLElement) {
    const head = el.createDiv({ cls: "pdfs-side-head" });
    head.createSpan({ text: `${this.store.annotations.length} annotations` });
    const exp = head.createEl("button", { cls: "pdfs-link-btn", text: "Export to note" });
    exp.addEventListener("click", () => void this.exportAnnotations());

    const list = [...this.store.annotations].sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0));
    if (!list.length) {
      el.createDiv({ cls: "pdfs-empty", text: "Select text and pick a color to highlight, or use the area tool." });
      return;
    }
    let page = -1;
    for (const a of list) {
      if (a.page !== page) {
        page = a.page;
        el.createDiv({ cls: "pdfs-ann-page", text: `Page ${page}` });
      }
      const item = el.createDiv({ cls: "pdfs-ann" });
      item.style.setProperty("--c", a.color);
      const meta = item.createDiv({ cls: "pdfs-ann-meta" });
      const icon = meta.createSpan();
      setIcon(icon, a.type === "area" ? "box-select" : a.type === "underline" ? "underline" : a.type === "strike" ? "strikethrough" : "highlighter");
      if (a.noteLink) {
        const l = meta.createSpan();
        setIcon(l, "link");
      }
      const more = meta.createSpan({ cls: "pdfs-ann-more clickable-icon" });
      setIcon(more, "more-horizontal");
      if (a.text) item.createDiv({ cls: "pdfs-ann-text", text: a.text });
      else if (a.type === "area") item.createDiv({ cls: "pdfs-ann-text pdfs-dim", text: "Area" });
      if (a.comment) item.createDiv({ cls: "pdfs-ann-comment", text: a.comment });
      item.addEventListener("click", () => this.goToAnnotation(a));
      const menu = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const m = new Menu();
        this.addAnnotationItems(m, a);
        m.showAtMouseEvent(e);
      };
      more.addEventListener("click", menu);
      item.addEventListener("contextmenu", menu);
    }
  }

  private renderLinksTab(el: HTMLElement) {
    const attached = this.store.links;
    el.createDiv({ cls: "pdfs-side-head", text: "Note links attached to this PDF" });
    if (!attached.length) {
      el.createDiv({ cls: "pdfs-empty", text: "Use the link button on a page, or the ⋯ menu on an outline heading, to attach a note." });
    }
    for (const l of [...attached].sort((a, b) => a.page - b.page)) {
      const item = el.createDiv({ cls: "pdfs-ann" });
      const meta = item.createDiv({ cls: "pdfs-ann-meta" });
      meta.createSpan({ text: l.kind === "heading" ? `“${l.title}” · p. ${l.page}` : `Page ${l.page}` });
      const rm = meta.createSpan({ cls: "pdfs-ann-more clickable-icon", attr: { "aria-label": "Remove" } });
      setIcon(rm, "x");
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        this.store.removeLink(l.id);
      });
      item.createDiv({ cls: "pdfs-ann-text", text: l.target });
      item.addEventListener("click", () => {
        this.goToPage(l.page);
        void this.plugin.openNoteLink(l.target, this.file?.path ?? "");
      });
    }

    el.createDiv({ cls: "pdfs-side-head pdfs-spaced", text: "Notes that link here" });
    if (!this.backlinks.length) {
      el.createDiv({ cls: "pdfs-empty", text: "No notes link to this PDF yet." });
      return;
    }
    const bySource = new Map<string, Backlink[]>();
    for (const b of this.backlinks) {
      const arr = bySource.get(b.source.path) ?? [];
      arr.push(b);
      bySource.set(b.source.path, arr);
    }
    for (const [, items] of bySource) {
      el.createDiv({ cls: "pdfs-ann-page", text: items[0].source.basename });
      for (const b of items.sort((x, y) => (x.info.page ?? 0) - (y.info.page ?? 0))) {
        const item = el.createDiv({ cls: "pdfs-ann" });
        const where = b.info.heading ? `“${b.info.heading}”` : b.info.annot ? "annotation" : "whole file";
        const pg = b.info.page ? ` · p. ${b.info.page}` : "";
        item.createDiv({ cls: "pdfs-ann-meta", text: `${where}${pg}` });
        item.createDiv({ cls: "pdfs-ann-text pdfs-dim", text: b.display });
        item.addEventListener("click", () => {
          if (b.info.page || b.info.heading || b.info.annot) this.applySubpath(`#${this.subOf(b)}`);
          void this.plugin.openNote(b.source, { line: b.line });
        });
      }
    }
  }

  private subOf(b: Backlink): string {
    const p: string[] = [];
    if (b.info.page) p.push(`page=${b.info.page}`);
    if (b.info.annot) p.push(`annot=${b.info.annot}`);
    if (b.info.heading) p.push(`heading=${encodeURIComponent(b.info.heading)}`);
    return p.join("&");
  }

  refreshBacklinks() {
    if (!this.file || !this.ready) return;
    this.backlinks = this.plugin.getBacklinks(this.file);
    for (let n = 1; n <= this.numPages; n++) this.renderPageTools(n);
    if (this.sideTab === "links") this.renderSidebar();
  }

  private onStoreChange(pages: number[]) {
    for (const p of new Set(pages)) {
      this.renderAnnots(p);
      this.renderPageTools(p);
    }
    if (this.sideTab !== "outline") this.renderSidebar();
  }

  // ------------------------------------------------------------------ outline

  private async loadOutline(token: number) {
    try {
      const raw = await this.pdf.getOutline();
      if (!raw) return;
      const walk = async (items: any[]): Promise<OutlineNode[]> =>
        Promise.all(
          items.map(async (it) => ({
            title: String(it.title ?? "").trim() || "(untitled)",
            page: await this.destToPage(it.dest),
            children: await walk(it.items ?? []),
          }))
        );
      const nodes = await walk(raw);
      if (token !== this.loadToken) return;
      this.outline = nodes;
      this.flatOutline = [];
      const flat = (ns: OutlineNode[]) => ns.forEach((n) => (this.flatOutline.push(n), flat(n.children)));
      flat(nodes);
      if (this.sideTab === "outline") this.renderSidebar();
    } catch (e) {
      console.warn("BetterPDF: could not read outline", e);
    }
  }

  private async destToPage(dest: any): Promise<number | null> {
    try {
      let d = dest;
      if (typeof d === "string") d = await this.pdf.getDestination(d);
      if (!Array.isArray(d)) return null;
      const ref = d[0];
      if (ref && typeof ref === "object") return (await this.pdf.getPageIndex(ref)) + 1;
      if (Number.isInteger(ref)) return ref + 1;
    } catch {
      /* unresolved destination */
    }
    return null;
  }

  // ------------------------------------------------------------------ page construction & layout

  private buildPages() {
    this.pagesEl.empty();
    this.pageEls = [];
    this.pst = [];
    for (let n = 1; n <= this.numPages; n++) {
      const el = createDiv({ cls: "pdfs-page", attr: { "data-page": String(n) } });
      el.createEl("canvas", { cls: "pdfs-canvas" });
      el.createDiv({ cls: "pdfs-annots" });
      el.createDiv({ cls: "textLayer" });
      el.createDiv({ cls: "pdfs-draw" });
      el.createDiv({ cls: "pdfs-page-tools" });
      this.pageEls.push(el);
      this.pst.push({ token: 0, busy: false, done: false, task: null });
      this.renderAnnots(n);
      this.renderPageTools(n);
    }
  }

  private buildRows() {
    this.pagesEl.empty();
    this.rows = [];
    this.pageToRow = [];
    this.spacerEl = null;
    const add = (pages: number[], spacer = false) => {
      const el = this.pagesEl.createDiv({ cls: "pdfs-row" });
      if (spacer) this.spacerEl = el.createDiv({ cls: "pdfs-spacer" });
      for (const p of pages) {
        el.appendChild(this.pageEls[p - 1]);
        this.pageToRow[p - 1] = this.rows.length;
      }
      this.rows.push({ el, pages });
    };
    const n = this.numPages;
    if (this.spreadMode === "none") {
      for (let p = 1; p <= n; p++) add([p]);
    } else if (this.spreadMode === "two") {
      for (let p = 1; p <= n; p += 2) add(p + 1 <= n ? [p, p + 1] : [p]);
    } else {
      add([1], true);
      for (let p = 2; p <= n; p += 2) add(p + 1 <= n ? [p, p + 1] : [p]);
    }
  }

  private refSize(): { w: number; h: number } {
    const a = this.sizes[0];
    const b = this.sizes[1];
    if (this.spreadMode === "none" || !b) return a;
    return { w: Math.max(a.w, b.w), h: Math.max(a.h, b.h) };
  }

  private computeScale(): number {
    if (typeof this.zoom === "number") return Math.min(8, Math.max(0.1, this.zoom * CSS_UNITS));
    const cw = this.scrollEl.clientWidth;
    const ch = this.scrollEl.clientHeight;
    if (cw < 50 || ch < 50) return this.scale;
    const cols = this.spreadMode === "none" ? 1 : 2;
    const ref = this.refSize();
    const byWidth = (cw - 2 * PAD - GAP * (cols - 1)) / (cols * ref.w);
    const s = this.zoom === "width" ? byWidth : Math.min(byWidth, (ch - 2 * PAD) / ref.h);
    return Math.min(8, Math.max(0.1, s));
  }

  private sizePage(i: number) {
    const el = this.pageEls[i];
    const s = this.sizes[i];
    if (!el || !s) return;
    el.style.width = `${s.w * this.scale}px`;
    el.style.height = `${s.h * this.scale}px`;
  }

  private applySizes() {
    for (let i = 0; i < this.pageEls.length; i++) this.sizePage(i);
    if (this.spacerEl) this.spacerEl.style.width = `${this.sizes[0].w * this.scale}px`;
  }

  private relayout(keepAnchor = true) {
    if (!this.pdf || !this.pageEls.length) return;
    const anchor = keepAnchor ? this.captureAnchor() : null;
    this.buildRows();
    this.scale = this.computeScale();
    this.applyPagedVisibility();
    this.applySizes();
    this.invalidateAll();
    if (anchor) this.restoreAnchor(anchor);
    this.io?.disconnect();
    for (const el of this.pageEls) this.io?.observe(el);
    this.syncToolbar();
  }

  private captureAnchor() {
    const row = this.rows[this.pageToRow[this.currentPage - 1]];
    if (!row || this.scrollMode === "paged") return { page: this.currentPage, frac: 0 };
    const h = row.el.offsetHeight || 1;
    return { page: this.currentPage, frac: (this.scrollEl.scrollTop - row.el.offsetTop) / h };
  }

  private restoreAnchor(a: { page: number; frac: number }) {
    this.currentPage = a.page;
    this.applyPagedVisibility();
    const row = this.rows[this.pageToRow[a.page - 1]];
    if (!row) return;
    this.scrollEl.scrollTop = row.el.offsetTop + a.frac * row.el.offsetHeight;
  }

  private applyPagedVisibility() {
    const cur = this.pageToRow[this.currentPage - 1];
    this.rows.forEach((r, i) => r.el.toggleClass("pdfs-hidden", this.scrollMode === "paged" && i !== cur));
  }

  private async loadSizes(token: number) {
    let changed = false;
    for (let i = 2; i <= this.numPages; i++) {
      if (token !== this.loadToken || !this.pdf) return;
      try {
        const p = await this.pdf.getPage(i);
        const v = p.getViewport({ scale: 1 });
        const cur = this.sizes[i - 1];
        if (Math.abs(cur.w - v.width) > 0.5 || Math.abs(cur.h - v.height) > 0.5) {
          this.sizes[i - 1] = { w: v.width, h: v.height };
          this.sizePage(i - 1);
          changed = true;
        }
        p.cleanup();
      } catch {
        /* skip unreadable page */
      }
    }
    if (changed && token === this.loadToken) {
      const s = this.computeScale();
      if (Math.abs(s - this.scale) / this.scale > 0.005) this.relayout();
    }
  }

  private onResizeCheck() {
    if (!this.ready || typeof this.zoom === "number") return;
    const s = this.computeScale();
    if (Math.abs(s - this.scale) / this.scale > 0.005) this.relayout();
  }

  // ------------------------------------------------------------------ rendering

  private invalidate(n: number) {
    const st = this.pst[n - 1];
    const el = this.pageEls[n - 1];
    if (!st || !el) return;
    st.token++;
    st.busy = false;
    st.done = false;
    try {
      st.task?.cancel?.();
    } catch {
      /* already finished */
    }
    st.task = null;
    const canvas = el.querySelector("canvas");
    if (canvas && canvas.width) {
      canvas.width = 0;
      canvas.height = 0;
    }
    el.querySelector(".textLayer")?.empty();
  }

  private invalidateAll() {
    for (let n = 1; n <= this.numPages; n++) this.invalidate(n);
  }

  private async renderPage(n: number) {
    const st = this.pst[n - 1];
    const el = this.pageEls[n - 1];
    if (!st || !el || st.busy || st.done || !this.pdf) return;
    st.busy = true;
    const token = st.token;
    try {
      const page = await this.pdf.getPage(n);
      if (token !== st.token) return;
      const base = page.getViewport({ scale: 1 });
      const cur = this.sizes[n - 1];
      if (Math.abs(cur.w - base.width) > 0.5 || Math.abs(cur.h - base.height) > 0.5) {
        this.sizes[n - 1] = { w: base.width, h: base.height };
        this.sizePage(n - 1);
      }
      const viewport = page.getViewport({ scale: this.scale });
      const canvas = el.querySelector("canvas") as HTMLCanvasElement;
      let ratio = window.devicePixelRatio || 1;
      const px = viewport.width * viewport.height * ratio * ratio;
      if (px > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      st.task = task;
      await task.promise;
      if (token !== st.token) return;
      await this.renderTextLayer(page, viewport, el.querySelector(".textLayer") as HTMLElement, token, st);
      if (token !== st.token) return;
      st.done = true;
      page.cleanup();
    } catch (e: any) {
      if (e?.name !== "RenderingCancelledException") console.error("BetterPDF: render failed on page", n, e);
    } finally {
      if (token === st.token) st.busy = false;
    }
  }

  private async renderTextLayer(page: any, viewport: any, container: HTMLElement, token: number, st: PageState) {
    container.empty();
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;
    container.style.setProperty("--scale-factor", String(viewport.scale));
    container.style.setProperty("--total-scale-factor", String(viewport.scale));
    container.style.setProperty("--user-unit", "1");
    const pdfjs: any = await loadPdfJs();
    if (token !== st.token) return;
    if (typeof pdfjs.TextLayer === "function") {
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true }),
        container,
        viewport,
      });
      await layer.render();
    } else if (typeof pdfjs.renderTextLayer === "function") {
      const tc = await page.getTextContent({ includeMarkedContent: true });
      if (token !== st.token) return;
      const task = pdfjs.renderTextLayer({
        textContentSource: tc,
        textContent: tc,
        container,
        viewport,
        textDivs: [],
      });
      await task.promise;
    }
  }

  // ------------------------------------------------------------------ navigation

  private onScroll() {
    if (!this.ready || this.scrollMode === "paged" || !this.rows.length) return;
    const probe = this.scrollEl.scrollTop + this.scrollEl.clientHeight * 0.35;
    let lo = 0;
    let hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.rows[mid].el.offsetTop <= probe) lo = mid;
      else hi = mid - 1;
    }
    const page = this.rows[lo].pages[0];
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.pageInput.value = String(page);
      this.saveMemorySoon();
    }
  }

  goToPage(n: number, yFrac = 0) {
    if (!this.pageEls.length) return;
    n = Math.min(Math.max(Math.round(n) || 1, 1), this.numPages);
    this.currentPage = n;
    this.applyPagedVisibility();
    const el = this.pageEls[n - 1];
    const top = el.offsetTop + yFrac * el.offsetHeight - (yFrac ? 90 : PAD / 2);
    this.scrollEl.scrollTop = Math.max(0, top);
    this.pageInput.value = String(n);
    this.saveMemorySoon();
  }

  step(dir: 1 | -1) {
    if (!this.rows.length) return;
    const idx = Math.min(Math.max(this.pageToRow[this.currentPage - 1] + dir, 0), this.rows.length - 1);
    this.goToPage(this.rows[idx].pages[0]);
  }

  private goToAnnotation(a: Annotation) {
    this.goToPage(a.page, a.rects[0]?.y ?? 0);
    activeWindow.setTimeout(() => this.flash(a.id), 80);
  }

  private flash(id: string) {
    const nodes = this.pagesEl.querySelectorAll(`.pdfs-annot[data-id="${id}"]`);
    nodes.forEach((n) => n.addClass("pdfs-flash"));
    activeWindow.setTimeout(() => nodes.forEach((n) => n.removeClass("pdfs-flash")), 1800);
  }

  applySubpath(sub: string) {
    const info = parseSubpath(sub);
    if (info.annot) {
      const a = this.store.get(info.annot);
      if (a) {
        this.goToAnnotation(a);
        return;
      }
    }
    if (info.heading) {
      const h = info.heading.toLowerCase();
      const node = this.flatOutline.find((o) => o.title.toLowerCase() === h && o.page);
      if (node?.page) {
        this.goToPage(node.page);
        return;
      }
    }
    if (info.page) this.goToPage(info.page);
  }

  // ------------------------------------------------------------------ zoom & layout controls

  private setZoom(z: ZoomMode) {
    this.zoom = z;
    this.relayout();
    this.saveMemorySoon();
  }

  private zoomBy(dir: 1 | -1) {
    const f = this.scale / CSS_UNITS;
    let next: number | undefined;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > f * 1.01);
    else next = [...ZOOM_STEPS].reverse().find((s) => s < f * 0.99);
    if (next) this.setZoom(next);
  }

  private applyWheelZoom() {
    const f = (this.scale / CSS_UNITS) * this.wheelFactor;
    this.wheelFactor = 1;
    this.setZoom(Math.min(8 / CSS_UNITS, Math.max(0.1 / CSS_UNITS, Math.round(f * 100) / 100)));
  }

  private setSpread(s: SpreadMode) {
    this.spreadMode = s;
    this.relayout();
    this.saveMemorySoon();
  }

  cycleSpread() {
    const order: SpreadMode[] = ["none", "two", "cover"];
    this.setSpread(order[(order.indexOf(this.spreadMode) + 1) % order.length]);
  }

  toggleInvert() {
    const s = this.plugin.settings;
    s.invert = !s.invert;
    this.rootEl.toggleClass("pdfs-invert", s.invert);
    this.invertBtn.toggleClass("is-active", s.invert);
    this.plugin.saveSettingsDebounced();
  }

  toggleAreaTool() {
    this.tool = this.tool === "area" ? "select" : "area";
    this.rootEl.toggleClass("pdfs-tool-area", this.tool === "area");
    this.syncToolbar();
  }

  private saveMemory() {
    const s = this.plugin.settings;
    if (!s.rememberView || !this.file || !this.ready) return;
    s.memory[this.file.path] = {
      page: this.currentPage,
      zoom: this.zoom,
      scroll: this.scrollMode,
      spread: this.spreadMode,
    };
    this.plugin.saveSettingsDebounced();
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select")) return;
    if (e.key === "Escape") {
      if (this.popEl || !this.selPopEl.hasClass("pdfs-hidden")) {
        this.closePopover();
        this.hideSelPop();
      } else if (this.tool === "area") this.toggleAreaTool();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.scrollMode === "paged") {
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        this.step(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
        e.preventDefault();
        this.step(-1);
      }
    }
  }

  // ------------------------------------------------------------------ annotations: drawing

  private renderAnnots(n: number) {
    const layer = this.pageEls[n - 1]?.querySelector(".pdfs-annots") as HTMLElement | null;
    if (!layer) return;
    layer.empty();
    for (const a of this.store?.byPage(n) ?? []) {
      a.rects.forEach((r) => {
        const d = layer.createDiv({ cls: `pdfs-annot pdfs-annot-${a.type}`, attr: { "data-id": a.id } });
        d.style.left = `${r.x * 100}%`;
        d.style.top = `${r.y * 100}%`;
        d.style.width = `${r.w * 100}%`;
        d.style.height = `${r.h * 100}%`;
        d.style.setProperty("--c", a.color);
      });
      if ((a.comment || a.noteLink) && a.rects[0]) {
        const r = a.rects[0];
        const pin = layer.createDiv({ cls: "pdfs-annot-pin", attr: { "data-id": a.id } });
        pin.style.left = `${(r.x + r.w) * 100}%`;
        pin.style.top = `${r.y * 100}%`;
        pin.style.setProperty("--c", a.color);
        setIcon(pin, a.noteLink ? "link" : "message-square");
      }
    }
  }

  private renderPageTools(n: number) {
    const box = this.pageEls[n - 1]?.querySelector(".pdfs-page-tools") as HTMLElement | null;
    if (!box) return;
    box.empty();
    for (const l of this.store?.links.filter((x) => x.page === n) ?? []) {
      const chip = box.createSpan({ cls: "pdfs-chip", text: l.kind === "heading" ? `${l.title} → ${this.targetName(l.target)}` : this.targetName(l.target) });
      chip.setAttr("aria-label", l.target);
      chip.addEventListener("click", () => void this.plugin.openNoteLink(l.target, this.file?.path ?? ""));
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const m = new Menu();
        m.addItem((i) => i.setTitle("Remove link").setIcon("trash-2").onClick(() => this.store.removeLink(l.id)));
        m.showAtMouseEvent(e);
      });
    }
    const bl = this.backlinks.filter((b) => b.info.page === n);
    if (bl.length) {
      const pill = box.createSpan({ cls: "pdfs-chip pdfs-chip-back" });
      const ic = pill.createSpan();
      setIcon(ic, "corner-up-left");
      pill.createSpan({ text: String(bl.length) });
      pill.setAttr("aria-label", `${bl.length} link${bl.length > 1 ? "s" : ""} from notes`);
      pill.addEventListener("click", (e) => {
        const m = new Menu();
        for (const b of bl) {
          m.addItem((i) => i.setTitle(`${b.source.basename}: ${b.display}`).setIcon("file-text").onClick(() => void this.plugin.openNote(b.source, { line: b.line })));
        }
        m.showAtMouseEvent(e);
      });
    }
    const add = box.createSpan({ cls: "pdfs-page-link clickable-icon", attr: { "aria-label": `Links for page ${n}` } });
    setIcon(add, "link");
    add.addEventListener("click", (e) => {
      const m = new Menu();
      this.addPageItems(m, n);
      m.showAtMouseEvent(e);
    });
  }

  private targetName(target: string): string {
    const m = target.match(/^\[\[([^\]|]+)/);
    return m ? m[1] : target.replace(/^\[|\].*$/g, "");
  }

  // ------------------------------------------------------------------ annotations: creation

  private toPx(c: DOMRect): PxRect {
    return { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
  }

  private mergeLineRects(rects: PxRect[], maxH: number): PxRect[] {
    const rs = rects
      .filter((r) => r.right - r.left > 1 && r.bottom - r.top > 1 && r.bottom - r.top < maxH)
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const contains = (o: PxRect, r: PxRect) => o.left <= r.left + 0.5 && o.right >= r.right - 0.5 && o.top <= r.top + 0.5 && o.bottom >= r.bottom - 0.5;
    const area = (r: PxRect) => (r.right - r.left) * (r.bottom - r.top);
    const kept = rs.filter((r, i) => !rs.some((o, j) => j !== i && contains(o, r) && (area(o) > area(r) || j < i)));
    const lines: PxRect[] = [];
    for (const r of kept) {
      const h = r.bottom - r.top;
      const line = lines.find((l) => {
        const lh = l.bottom - l.top;
        const dy = Math.abs((l.top + l.bottom) / 2 - (r.top + r.bottom) / 2);
        return dy < Math.min(h, lh) * 0.5 && r.left <= l.right + Math.min(h, lh) * 0.8 && r.right >= l.left - Math.min(h, lh) * 0.8;
      });
      if (line) {
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else lines.push({ ...r });
    }
    return lines;
  }

  private getSelectionInfo(): { n: number; rects: Rect[]; text: string }[] {
    const sel = activeWindow.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    if (!this.pagesEl.contains(range.commonAncestorContainer)) return [];
    const out: { n: number; rects: Rect[]; text: string }[] = [];
    this.pageEls.forEach((el, i) => {
      const tl = el.querySelector(".textLayer");
      if (!tl || !tl.firstChild || !range.intersectsNode(tl)) return;
      const r = range.cloneRange();
      if (!tl.contains(range.startContainer)) r.setStart(tl, 0);
      if (!tl.contains(range.endContainer)) r.setEnd(tl, tl.childNodes.length);
      const text = r.toString().replace(/\s+/g, " ").trim();
      if (!text) return;
      const box = el.getBoundingClientRect();
      const merged = this.mergeLineRects(Array.from(r.getClientRects()).map((c) => this.toPx(c)), box.height * 0.15);
      const rects = merged.map((m) => ({
        x: Math.max(0, (m.left - box.left) / box.width),
        y: Math.max(0, (m.top - box.top) / box.height),
        w: Math.min(1, (m.right - m.left) / box.width),
        h: Math.min(1, (m.bottom - m.top) / box.height),
      }));
      if (rects.length) out.push({ n: i + 1, rects, text });
    });
    return out;
  }

  private annotateSelection(type: AnnotType, color: string): Annotation[] {
    const info = this.getSelectionInfo();
    if (!info.length) return [];
    const list: Annotation[] = info.map((p) => ({
      id: newId(),
      page: p.n,
      type,
      color,
      rects: p.rects,
      text: p.text,
      created: Date.now(),
    }));
    this.store.add(list);
    activeWindow.getSelection()?.removeAllRanges();
    this.hideSelPop();
    return list;
  }

  private buildSelectionPopup() {
    this.selPopEl = this.rootEl.createDiv({ cls: "pdfs-selpop pdfs-hidden" });
    this.selPopEl.addEventListener("mousedown", (e) => e.preventDefault());
  }

  private updateSelectionPopup() {
    const info = this.getSelectionInfo();
    const sel = activeWindow.getSelection();
    if (!info.length || !sel || !this.ready) {
      this.hideSelPop();
      return;
    }
    const pop = this.selPopEl;
    pop.empty();
    for (const c of this.plugin.settings.colors) {
      const sw = pop.createEl("button", { cls: "pdfs-swatch", attr: { "aria-label": "Highlight" } });
      sw.style.background = c;
      sw.addEventListener("click", () => this.annotateSelection("highlight", c));
    }
    const c0 = this.plugin.settings.colors[0];
    this.btn(pop, "underline", "Underline", () => this.annotateSelection("underline", "#e5484d"));
    this.btn(pop, "strikethrough", "Strikethrough", () => this.annotateSelection("strike", "#e5484d"));
    pop.createSpan({ cls: "pdfs-sep" });
    this.btn(pop, "link", "Highlight and copy link", () => {
      const list = this.annotateSelection("highlight", c0);
      if (list[0]) void this.plugin.copy(this.annotLink(list[0]), "Link copied");
    });
    this.btn(pop, "quote", "Highlight and copy quote with link", () => {
      const list = this.annotateSelection("highlight", c0);
      if (list[0]) void this.plugin.copy(this.annotQuote(list[0]), "Quote copied");
    });

    const rects = sel.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1];
    if (!last) return;
    const root = this.rootEl.getBoundingClientRect();
    pop.removeClass("pdfs-hidden");
    const w = pop.offsetWidth || 260;
    pop.style.left = `${Math.min(Math.max(last.right - root.left - w / 2, 8), root.width - w - 8)}px`;
    pop.style.top = `${last.bottom - root.top + 8}px`;
  }

  private hideSelPop() {
    this.selPopEl?.addClass("pdfs-hidden");
  }

  // area tool
  private onDrawStart(e: PointerEvent) {
    if (this.tool !== "area" || e.button !== 0) return;
    const draw = (e.target as HTMLElement).closest(".pdfs-draw");
    const pageEl = draw?.parentElement;
    if (!draw || !pageEl) return;
    e.preventDefault();
    const n = Number(pageEl.dataset.page);
    const box = pageEl.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const ghost = draw.createDiv({ cls: "pdfs-ghost" });
    const color = this.plugin.settings.colors[0];
    ghost.style.setProperty("--c", color);
    const clampX = (x: number) => Math.min(Math.max(x, box.left), box.right);
    const clampY = (y: number) => Math.min(Math.max(y, box.top), box.bottom);
    const rect = (ev: PointerEvent) => {
      const x1 = clampX(ev.clientX);
      const y1 = clampY(ev.clientY);
      return { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) };
    };
    const move = (ev: PointerEvent) => {
      const r = rect(ev);
      ghost.style.left = `${r.l - box.left}px`;
      ghost.style.top = `${r.t - box.top}px`;
      ghost.style.width = `${r.r - r.l}px`;
      ghost.style.height = `${r.b - r.t}px`;
    };
    const doc = activeDocument;
    const up = (ev: PointerEvent) => {
      doc.removeEventListener("pointermove", move);
      ghost.remove();
      const r = rect(ev);
      if (r.r - r.l < 8 || r.b - r.t < 8) return;
      const a: Annotation = {
        id: newId(),
        page: n,
        type: "area",
        color,
        rects: [{ x: (r.l - box.left) / box.width, y: (r.t - box.top) / box.height, w: (r.r - r.l) / box.width, h: (r.b - r.t) / box.height }],
        created: Date.now(),
      };
      this.store.add([a]);
      this.toggleAreaTool();
      this.openPopover(a, ev.clientX, ev.clientY);
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up, { once: true });
  }

  private onPageClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest(".pdfs-page-tools") || this.tool === "area") return;
    const sel = activeWindow.getSelection();
    if (sel && !sel.isCollapsed) return;
    const pageEl = t.closest(".pdfs-page") as HTMLElement | null;
    if (!pageEl) return;
    const n = Number(pageEl.dataset.page);
    const box = pageEl.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    const pad = 2 / box.height;
    const hits = this.store.byPage(n).filter((a) => a.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y - pad && y <= r.y + r.h + pad));
    if (!hits.length) {
      this.closePopover();
      return;
    }
    this.openPopover(hits[hits.length - 1], e.clientX, e.clientY);
  }

  // ------------------------------------------------------------------ annotations: popover & menus

  private closePopover() {
    this.popEl?.remove();
    this.popEl = null;
    if (this.popOutside) {
      activeDocument.removeEventListener("mousedown", this.popOutside, true);
      this.popOutside = null;
    }
  }

  private openPopover(a: Annotation, cx: number, cy: number) {
    this.closePopover();
    this.hideSelPop();
    const pop = this.rootEl.createDiv({ cls: "pdfs-pop" });
    this.popEl = pop;

    const head = pop.createDiv({ cls: "pdfs-pop-row" });
    for (const c of this.plugin.settings.colors) {
      const sw = head.createEl("button", { cls: "pdfs-swatch" + (c === a.color ? " is-active" : "") });
      sw.style.background = c;
      sw.addEventListener("click", () => {
        this.store.update(a.id, { color: c });
        this.openPopover(a, cx, cy);
      });
    }
    if (a.type !== "area") {
      head.createSpan({ cls: "pdfs-sep" });
      const types: [AnnotType, string, string][] = [
        ["highlight", "highlighter", "Highlight"],
        ["underline", "underline", "Underline"],
        ["strike", "strikethrough", "Strikethrough"],
      ];
      for (const [type, icon, title] of types) {
        const b = this.btn(head, icon, title, () => {
          this.store.update(a.id, { type });
          this.openPopover(a, cx, cy);
        });
        b.toggleClass("is-active", a.type === type);
      }
    }
    head.createSpan({ cls: "pdfs-grow" });
    this.btn(head, "trash-2", "Delete annotation", () => {
      this.store.remove(a.id);
      this.closePopover();
    });

    if (a.text) pop.createDiv({ cls: "pdfs-pop-quote", text: a.text });
    const ta = pop.createEl("textarea", { cls: "pdfs-pop-comment", attr: { placeholder: "Add a comment…", rows: "3" } });
    ta.value = a.comment ?? "";
    ta.addEventListener("input", () => this.store.update(a.id, { comment: ta.value || undefined }));

    const linkRow = pop.createDiv({ cls: "pdfs-pop-row" });
    if (a.noteLink) {
      const chip = linkRow.createSpan({ cls: "pdfs-chip", text: this.targetName(a.noteLink) });
      chip.addEventListener("click", () => void this.plugin.openNoteLink(a.noteLink!, this.file?.path ?? ""));
      this.btn(linkRow, "x", "Remove note link", () => {
        this.store.update(a.id, { noteLink: undefined });
        this.openPopover(a, cx, cy);
      });
    } else {
      const b = linkRow.createEl("button", { text: "Link to note…" });
      b.addEventListener("click", () => this.linkAnnotationToNote(a));
    }
    linkRow.createSpan({ cls: "pdfs-grow" });
    this.btn(linkRow, "more-horizontal", "More actions", (e) => {
      const m = new Menu();
      this.addAnnotationItems(m, a, true);
      m.showAtMouseEvent(e);
    });

    const root = this.rootEl.getBoundingClientRect();
    const w = 300;
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.min(Math.max(cx - root.left - w / 2, 8), Math.max(8, root.width - w - 8))}px`;
    const below = cy - root.top + 14;
    pop.style.top = `${below + 240 > root.height ? Math.max(8, cy - root.top - 250) : below}px`;

    this.popOutside = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".pdfs-pop") || t.closest(".menu")) return;
      this.closePopover();
    };
    activeDocument.addEventListener("mousedown", this.popOutside, true);
  }

  private linkAnnotationToNote(a: Annotation) {
    pickNote(this.app, true, (file, heading) => {
      const link = this.app.fileManager.generateMarkdownLink(file, this.file?.path ?? "", heading ? `#${heading}` : "");
      this.store.update(a.id, { noteLink: link });
      if (this.popEl) this.openPopover(this.store.get(a.id)!, this.popEl.getBoundingClientRect().left + 150, this.popEl.getBoundingClientRect().top);
    });
  }

  private annotLink(a: Annotation, sourcePath = ""): string {
    const file = this.file!;
    return this.plugin.makeLink(file, { page: a.page, annot: a.id }, `${sanitizeAlias(file.basename, 30)}, p. ${a.page}`, sourcePath);
  }

  private annotQuote(a: Annotation, sourcePath = ""): string {
    const link = this.annotLink(a, sourcePath);
    let out = a.text
      ? a.text
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n") + `\n> — ${link}`
      : `> (area on page ${a.page}) — ${link}`;
    if (a.comment) out += `\n\n${a.comment}`;
    return out;
  }

  private addAnnotationItems(m: Menu, a: Annotation, skipLinkItem = false) {
    m.addItem((i) => i.setTitle("Copy link").setIcon("link").onClick(() => void this.plugin.copy(this.annotLink(a), "Link copied")));
    m.addItem((i) => i.setTitle("Copy quote with link").setIcon("quote").onClick(() => void this.plugin.copy(this.annotQuote(a), "Quote copied")));
    m.addItem((i) => i.setTitle("Insert quote into open note").setIcon("file-input").onClick(() => this.plugin.insertIntoOpenNote(this.annotQuote(a))));
    m.addItem((i) =>
      i
        .setTitle("Send to note…")
        .setIcon("send")
        .onClick(() => pickNote(this.app, false, (f) => void this.plugin.appendToNote(f, this.annotQuote(a, f.path))))
    );
    if (!skipLinkItem) m.addItem((i) => i.setTitle("Link to note…").setIcon("link-2").onClick(() => this.linkAnnotationToNote(a)));
    m.addSeparator();
    m.addItem((i) =>
      i.setTitle("Delete").setIcon("trash-2").onClick(() => {
        this.store.remove(a.id);
        this.closePopover();
      })
    );
  }

  // ------------------------------------------------------------------ page/heading links

  private pageLink(page: number, title?: string, sourcePath = ""): string {
    const file = this.file!;
    const alias = title ? sanitizeAlias(title) : `${sanitizeAlias(file.basename, 30)}, p. ${page}`;
    return this.plugin.makeLink(file, { page, heading: title }, alias, sourcePath);
  }

  private addPageItems(m: Menu, page: number, title?: string) {
    const what = title ? "heading" : "page";
    m.addItem((i) => i.setTitle(`Copy link to ${what}`).setIcon("link").onClick(() => void this.plugin.copy(this.pageLink(page, title), "Link copied")));
    m.addItem((i) => i.setTitle(`Insert ${what} link into open note`).setIcon("file-input").onClick(() => this.plugin.insertIntoOpenNote(this.pageLink(page, title))));
    m.addItem((i) =>
      i
        .setTitle(`Add ${what} link to a note…`)
        .setIcon("send")
        .onClick(() => pickNote(this.app, false, (f) => void this.plugin.appendToNote(f, this.pageLink(page, title, f.path))))
    );
    m.addItem((i) =>
      i
        .setTitle(`Attach a note to this ${what}…`)
        .setIcon("link-2")
        .onClick(() =>
          pickNote(this.app, true, (file, heading) => {
            const target = this.app.fileManager.generateMarkdownLink(file, this.file?.path ?? "", heading ? `#${heading}` : "");
            this.store.addLink({ id: newId(), kind: title ? "heading" : "page", page, title, target });
          })
        )
    );
  }

  copyPageLink() {
    if (!this.file) return;
    void this.plugin.copy(this.pageLink(this.currentPage), `Link to page ${this.currentPage} copied`);
  }

  insertPageLink() {
    if (!this.file) return;
    this.plugin.insertIntoOpenNote(this.pageLink(this.currentPage));
  }

  async exportAnnotations() {
    const file = this.file;
    if (!file || !this.store) return;
    const list = [...this.store.annotations].sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0));
    if (!list.length) {
      new Notice("No annotations to export yet.");
      return;
    }
    const folder = file.parent && !file.parent.isRoot() ? file.parent.path : "";
    const base = normalizePath(`${folder}/${file.basename} annotations`);
    let path = `${base}.md`;
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = `${base} ${i}.md`;
    const lines = [`# Annotations: ${file.basename}`, "", `Source: ${this.plugin.makeLink(file, {}, undefined, path)}`, ""];
    let page = -1;
    for (const a of list) {
      if (a.page !== page) {
        page = a.page;
        lines.push(`## Page ${page}`, "");
      }
      lines.push(this.annotQuote(a, path), "");
    }
    const note = await this.app.vault.create(path, lines.join("\n"));
    new Notice(`Exported to ${note.path}`);
    await this.plugin.openNote(note);
  }
}
