import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  parseLinktext,
} from "obsidian";
import { BetterPdfView } from "./view";
import { buildSubpath, collectBacklinks, linktextFromStored, Backlink } from "./links";
import { SIDECAR_SUFFIX } from "./store";
import { DEFAULT_SETTINGS, BetterPdfSettings, SubpathInfo, VIEW_TYPE } from "./types";

export default class BetterPdfPlugin extends Plugin {
  settings!: BetterPdfSettings;
  private tookOver = false;
  private saveSettingsSoon = 0;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new BetterPdfView(leaf, this));
    if (this.settings.takeOverPdfs) this.takeOverExtension();

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "pdf") {
          menu.addItem((i) =>
            i
              .setTitle("Open in BetterPDF")
              .setIcon("book-open")
              .onClick(() => this.openInBetterPdf(file))
          );
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (!(file instanceof TFile) || file.extension !== "pdf") return;
        const ad = this.app.vault.adapter;
        try {
          if (await ad.exists(oldPath + SIDECAR_SUFFIX)) {
            await ad.rename(oldPath + SIDECAR_SUFFIX, file.path + SIDECAR_SUFFIX);
          }
        } catch (e) {
          console.error("BetterPDF: could not move annotation file", e);
        }
        const mem = this.settings.memory[oldPath];
        if (mem) {
          this.settings.memory[file.path] = mem;
          delete this.settings.memory[oldPath];
          this.saveSettingsDebounced();
        }
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        window.clearTimeout(this.backlinkTimer);
        this.backlinkTimer = window.setTimeout(() => this.forEachView((v) => v.refreshBacklinks()), 600);
      })
    );

    this.addCommand({
      id: "open-in-better-pdf",
      name: "Open current PDF in BetterPDF",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "pdf") return false;
        if (!checking) this.openInBetterPdf(f);
        return true;
      },
    });

    const viewCmd = (id: string, name: string, run: (v: BetterPdfView) => void) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const v = this.activeView();
          if (!v) return false;
          if (!checking) run(v);
          return true;
        },
      });

    viewCmd("copy-page-link", "Copy link to current PDF page", (v) => v.copyPageLink());
    viewCmd("insert-page-link", "Insert link to current PDF page into open note", (v) => v.insertPageLink());
    viewCmd("cycle-spread", "Cycle single / two-page / two-page with cover", (v) => v.cycleSpread());
    viewCmd("toggle-sidebar", "Toggle PDF sidebar", (v) => v.toggleSidebar());
    viewCmd("toggle-area", "Toggle area annotation tool", (v) => v.toggleAreaTool());
    viewCmd("toggle-invert", "Toggle dark page colors", (v) => v.toggleInvert());
    viewCmd("export-annotations", "Export PDF annotations to a note", (v) => void v.exportAnnotations());
    viewCmd("next-page", "Next PDF page / spread", (v) => v.step(1));
    viewCmd("prev-page", "Previous PDF page / spread", (v) => v.step(-1));

    this.addSettingTab(new BetterPdfSettingTab(this.app, this));
  }

  onunload() {
    if (this.tookOver) {
      const reg = (this.app as any).viewRegistry;
      window.setTimeout(() => {
        try {
          reg.unregisterExtensions(["pdf"]);
        } catch {
          /* already removed */
        }
        try {
          reg.registerExtensions(["pdf"], "pdf");
        } catch (e) {
          console.error("BetterPDF: could not restore the built-in PDF viewer", e);
        }
      }, 0);
    }
  }

  private backlinkTimer = 0;

  private takeOverExtension() {
    const reg = (this.app as any).viewRegistry;
    try {
      reg.unregisterExtensions(["pdf"]);
      this.registerExtensions(["pdf"], VIEW_TYPE);
      this.tookOver = true;
    } catch (e) {
      console.error("BetterPDF: could not replace the built-in PDF viewer", e);
      new Notice("BetterPDF: could not replace the default PDF viewer. Use 'Open in BetterPDF' from the file menu.");
      try {
        reg.registerExtensions(["pdf"], "pdf");
      } catch {
        /* still registered */
      }
    }
  }

  async openInBetterPdf(file: TFile) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  forEachView(fn: (v: BetterPdfView) => void) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof BetterPdfView) fn(leaf.view);
    }
  }

  activeView(): BetterPdfView | null {
    const v = this.app.workspace.getActiveViewOfType(BetterPdfView);
    return v && v.file ? v : null;
  }

  // ---- links ----

  makeLink(file: TFile, info: SubpathInfo, alias?: string, sourcePath = ""): string {
    return this.app.fileManager.generateMarkdownLink(file, sourcePath, buildSubpath(info), alias);
  }

  getBacklinks(file: TFile): Backlink[] {
    return collectBacklinks(this.app, file);
  }

  async copy(text: string, notice: string) {
    await navigator.clipboard.writeText(text);
    new Notice(notice);
  }

  private markdownLeaf(): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    if (!leaves.length) return null;
    return leaves.sort((a, b) => ((b as any).activeTime ?? 0) - ((a as any).activeTime ?? 0))[0];
  }

  insertIntoOpenNote(text: string): boolean {
    const leaf = this.markdownLeaf();
    const view = leaf?.view;
    if (view instanceof MarkdownView && view.getMode() === "source") {
      view.editor.replaceSelection(text);
      new Notice(`Inserted into ${view.file?.basename ?? "note"}`);
      return true;
    }
    new Notice("No note open in edit mode. Use 'Send to note…' instead.");
    return false;
  }

  async appendToNote(file: TFile, text: string) {
    await this.app.vault.process(file, (data) => data.replace(/\s*$/, "") + "\n\n" + text + "\n");
    new Notice(`Added to ${file.basename}`);
  }

  async openNoteLink(stored: string, sourcePath: string) {
    const linktext = linktextFromStored(stored);
    if (!linktext) return;
    const { path, subpath } = parseLinktext(linktext);
    const dest = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!dest) {
      new Notice(`Note not found: ${path}`);
      return;
    }
    await this.openNote(dest, { subpath });
  }

  async openNote(file: TFile, eState: Record<string, unknown> = {}) {
    const leaf = this.markdownLeaf() ?? this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(file, { eState });
    this.app.workspace.revealLeaf(leaf);
  }

  // ---- settings ----

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.colors) || this.settings.colors.length === 0) {
      this.settings.colors = [...DEFAULT_SETTINGS.colors];
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  saveSettingsDebounced() {
    window.clearTimeout(this.saveSettingsSoon);
    this.saveSettingsSoon = window.setTimeout(() => void this.saveSettings(), 800);
  }
}

class BetterPdfSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BetterPdfPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Use BetterPDF for all PDFs")
      .setDesc("Replaces Obsidian's built-in PDF viewer. Reload the plugin (or Obsidian) after changing. Embeds in notes still use the built-in embed.")
      .addToggle((t) =>
        t.setValue(s.takeOverPdfs).onChange(async (v) => {
          s.takeOverPdfs = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Default scrolling")
      .addDropdown((d) =>
        d
          .addOptions({ continuous: "Continuous", paged: "One page / spread at a time" })
          .setValue(s.defaultScroll)
          .onChange(async (v) => {
            s.defaultScroll = v as typeof s.defaultScroll;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default page layout")
      .addDropdown((d) =>
        d
          .addOptions({ none: "Single page", two: "Two pages", cover: "Two pages, cover alone" })
          .setValue(s.defaultSpread)
          .onChange(async (v) => {
            s.defaultSpread = v as typeof s.defaultSpread;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default zoom")
      .addDropdown((d) =>
        d
          .addOptions({ width: "Fit width", page: "Fit page" })
          .setValue(s.defaultZoom)
          .onChange(async (v) => {
            s.defaultZoom = v as typeof s.defaultZoom;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remember page and layout per PDF")
      .addToggle((t) =>
        t.setValue(s.rememberView).onChange(async (v) => {
          s.rememberView = v;
          await this.plugin.saveSettings();
        })
      );

    const colors = new Setting(containerEl).setName("Highlight colors").setDesc("The first color is used for area annotations.");
    s.colors.forEach((c, i) => {
      colors.addColorPicker((p) =>
        p.setValue(c).onChange(async (v) => {
          s.colors[i] = v;
          await this.plugin.saveSettings();
        })
      );
    });
  }
}
