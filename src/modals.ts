import { App, FuzzySuggestModal, TFile } from "obsidian";

interface HeadingChoice {
  label: string;
  heading?: string;
}

class HeadingModal extends FuzzySuggestModal<HeadingChoice> {
  constructor(app: App, private file: TFile, private cb: (file: TFile, heading?: string) => void) {
    super(app);
    this.setPlaceholder(`Heading in ${file.basename} (or whole note)`);
  }
  getItems(): HeadingChoice[] {
    const hs = this.app.metadataCache.getFileCache(this.file)?.headings ?? [];
    return [
      { label: "(whole note)" },
      ...hs.map((h) => ({ label: `${"  ".repeat(h.level - 1)}${h.heading}`, heading: h.heading })),
    ];
  }
  getItemText(item: HeadingChoice): string {
    return item.label;
  }
  onChooseItem(item: HeadingChoice): void {
    this.cb(this.file, item.heading);
  }
}

class NoteModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private pickHeading: boolean,
    private cb: (file: TFile, heading?: string) => void
  ) {
    super(app);
    this.setPlaceholder("Choose a note");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    if (!this.pickHeading) {
      this.cb(f);
      return;
    }
    window.setTimeout(() => new HeadingModal(this.app, f, this.cb).open(), 0);
  }
}

export function pickNote(app: App, pickHeading: boolean, cb: (file: TFile, heading?: string) => void) {
  new NoteModal(app, pickHeading, cb).open();
}
