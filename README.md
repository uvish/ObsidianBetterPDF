# BetterPDF

A fuller PDF reader for [Obsidian](https://obsidian.md): annotations, two-page spreads, and deep links between PDFs and your notes.

## Features

- **Layouts:** single page, two pages, or two pages with the cover alone; continuous or page-by-page scrolling; fit width / fit page / zoom; dark page mode. Remembers page and layout per PDF.
- **Annotations:** highlight (5 colors), underline, strikethrough, and area boxes, each with an optional comment. Stored next to the PDF as `<file>.pdf.annots.json`.
- **Links into notes:** copy or insert links to a page, an outline heading, or an annotation (`[[file.pdf#page=12&annot=ab12cd]]`). Copy an annotation as a quote with its link, or send it to a note. Clicking such a link opens the PDF at that spot.
- **Links out of the PDF:** attach a note (or note heading) to any page, outline heading, or annotation; see which notes link to each page.
- **Sidebar:** outline, annotation list, and links. Export all annotations to a note.

## Installation

Not yet in the community plugin directory. Install manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Copy them to `<your vault>/.obsidian/plugins/better-pdf/`.
3. Enable **BetterPDF** under Settings → Community plugins.

By default it replaces Obsidian's built-in PDF viewer (toggle in the plugin settings, or use *Open in BetterPDF* from the file menu).

### Build from source

```
npm install
npm run build
```

## Not yet supported

Text search, freehand ink, thumbnails.
