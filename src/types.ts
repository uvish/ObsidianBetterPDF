export const VIEW_TYPE = "better-pdf-view";
export const CSS_UNITS = 96 / 72;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotType = "highlight" | "underline" | "strike" | "area";

export interface Annotation {
  id: string;
  page: number;
  type: AnnotType;
  color: string;
  rects: Rect[];
  text?: string;
  comment?: string;
  noteLink?: string;
  created: number;
}

export interface AttachedLink {
  id: string;
  kind: "page" | "heading";
  page: number;
  title?: string;
  target: string;
}

export interface SidecarData {
  version: 1;
  annotations: Annotation[];
  links: AttachedLink[];
}

export type ScrollMode = "continuous" | "paged";
export type SpreadMode = "none" | "two" | "cover";
export type ZoomMode = "width" | "page" | number;

export interface ViewMemory {
  page: number;
  zoom: ZoomMode;
  scroll: ScrollMode;
  spread: SpreadMode;
}

export interface BetterPdfSettings {
  takeOverPdfs: boolean;
  defaultScroll: ScrollMode;
  defaultSpread: SpreadMode;
  defaultZoom: "width" | "page";
  colors: string[];
  rememberView: boolean;
  invert: boolean;
  memory: Record<string, ViewMemory>;
}

export const DEFAULT_SETTINGS: BetterPdfSettings = {
  takeOverPdfs: true,
  defaultScroll: "continuous",
  defaultSpread: "none",
  defaultZoom: "width",
  colors: ["#ffd400", "#7bd88f", "#6ec1ff", "#ff8fb1", "#c4a1ff"],
  rememberView: true,
  invert: false,
  memory: {},
};

export interface OutlineNode {
  title: string;
  page: number | null;
  children: OutlineNode[];
}

export interface SubpathInfo {
  page?: number;
  annot?: string;
  heading?: string;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 9);
}
