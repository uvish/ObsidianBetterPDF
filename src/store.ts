import { App, Notice, debounce } from "obsidian";
import { Annotation, AttachedLink, SidecarData } from "./types";

export const SIDECAR_SUFFIX = ".annots.json";

export class AnnotationStore {
  data: SidecarData = { version: 1, annotations: [], links: [] };
  private existsOnDisk = false;
  private dirty = false;
  private saveSoon: () => unknown = debounce(() => void this.flush(), 700, true);

  constructor(
    private app: App,
    private getPdfPath: () => string,
    public onChange: (pages: number[]) => void
  ) {}

  get path(): string {
    return this.getPdfPath() + SIDECAR_SUFFIX;
  }

  async load(): Promise<void> {
    const ad = this.app.vault.adapter;
    this.existsOnDisk = await ad.exists(this.path);
    if (!this.existsOnDisk) return;
    try {
      const parsed = JSON.parse(await ad.read(this.path));
      this.data = {
        version: 1,
        annotations: Array.isArray(parsed.annotations) ? parsed.annotations : [],
        links: Array.isArray(parsed.links) ? parsed.links : [],
      };
    } catch (e) {
      console.error("BetterPDF: could not parse annotation file", e);
      new Notice("BetterPDF: annotation file is corrupt and was not loaded. It will not be overwritten.");
      this.dirty = false;
      this.saveSoon = () => {};
      this.flush = async () => {};
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const { annotations, links } = this.data;
    if (!this.existsOnDisk && annotations.length === 0 && links.length === 0) return;
    await this.app.vault.adapter.write(this.path, JSON.stringify(this.data, null, 1));
    this.existsOnDisk = true;
  }

  private touch(pages: number[]) {
    this.dirty = true;
    this.saveSoon();
    this.onChange(pages);
  }

  get annotations(): Annotation[] {
    return this.data.annotations;
  }

  get(id: string): Annotation | undefined {
    return this.data.annotations.find((a) => a.id === id);
  }

  byPage(page: number): Annotation[] {
    return this.data.annotations.filter((a) => a.page === page);
  }

  add(list: Annotation[]) {
    this.data.annotations.push(...list);
    this.touch(list.map((a) => a.page));
  }

  update(id: string, patch: Partial<Annotation>) {
    const a = this.get(id);
    if (!a) return;
    Object.assign(a, patch);
    this.touch([a.page]);
  }

  remove(id: string) {
    const a = this.get(id);
    if (!a) return;
    this.data.annotations = this.data.annotations.filter((x) => x.id !== id);
    this.touch([a.page]);
  }

  get links(): AttachedLink[] {
    return this.data.links;
  }

  addLink(l: AttachedLink) {
    this.data.links.push(l);
    this.touch([l.page]);
  }

  removeLink(id: string) {
    const l = this.data.links.find((x) => x.id === id);
    if (!l) return;
    this.data.links = this.data.links.filter((x) => x.id !== id);
    this.touch([l.page]);
  }
}
