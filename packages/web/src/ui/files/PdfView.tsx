/**
 * PDF, page by page, with pdf.js bundled from npm (docs/files.md). A page is drawn when it scrolls near, at the width
 * of the pane (or zoomed), and dropped again when it is far away, so a long document stays light.
 *
 * Not the browser's own viewer in a frame: Chromium's does show a /media PDF in one, sandbox CSP and all, but the
 * Android app's WebView has no PDF viewer, and Chromium's runs a PDF's own script. pdf.js is the same viewer
 * everywhere: it parses in a worker, runs none of the file's scripts (no scripting build is loaded), and only paints
 * to canvases.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { FileViewProps } from '../Viewer.tsx';
import { Failed, Waiting } from './load.tsx';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** Pages drawn at once, around what is in view. */
const NEAR = '1200px 0px';

export default function PdfView({ att }: FileViewProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ratio, setRatio] = useState(1.414);
  const [zoom, setZoom] = useState(2);
  const [page, setPage] = useState(1);
  const pane = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let live = true;
    const task = pdfjs.getDocument({ url: new URL(att.url, location.href).href, enableXfa: false, stopAtErrors: false });
    task.promise
      .then(async (d) => {
        if (!live) return;
        const first = await d.getPage(1);
        const v = first.getViewport({ scale: 1 });
        setRatio(v.height / v.width);
        setDoc(d);
      })
      .catch((e) => live && setError(e?.name === 'PasswordException' ? 'This PDF has a password. Download it to open it.' : `Could not read this PDF: ${e?.message ?? e}`));
    return () => {
      live = false;
      void task.destroy();
    };
  }, [att.url]);

  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  // Which page is in view, for the counter.
  useEffect(() => {
    const el = pane.current;
    if (!el || !doc) return;
    const io = new IntersectionObserver(
      (es) => {
        const best = es.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (best) setPage(Number((best.target as HTMLElement).dataset.page));
      },
      { root: el.closest('.fviewer-body'), threshold: [0.25, 0.5, 0.75] },
    );
    el.querySelectorAll('.fv-page').forEach((p) => io.observe(p));
    return () => io.disconnect();
  }, [doc, width]);

  if (error) return <Failed error={error} />;
  if (!doc) return <Waiting />;
  const pageWidth = Math.max(100, Math.min(width - 16, 900) * ZOOMS[zoom]);
  return (
    <div class="fv-pdf">
      <div class="fv-tools">
        <span class="fv-tools-info" aria-live="polite">
          Page {page} of {doc.numPages}
        </span>
        <button class="chip-btn" onClick={() => setZoom(Math.max(0, zoom - 1))} disabled={zoom === 0} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <span class="fv-zoom">{Math.round(ZOOMS[zoom] * 100)}%</span>
        <button class="chip-btn" onClick={() => setZoom(Math.min(ZOOMS.length - 1, zoom + 1))} disabled={zoom === ZOOMS.length - 1} aria-label="Zoom in" title="Zoom in">
          +
        </button>
      </div>
      <div class="fv-pages" ref={pane}>
        {width > 0 && Array.from({ length: doc.numPages }, (_, i) => <Page key={i} doc={doc} n={i + 1} width={pageWidth} ratio={ratio} />)}
      </div>
    </div>
  );
}

function Page({ doc, n, width, ratio }: { doc: PDFDocumentProxy; n: number; width: number; ratio: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [h, setH] = useState(width * ratio);

  useEffect(() => {
    const el = box.current!;
    const io = new IntersectionObserver((es) => setNear(es.some((e) => e.isIntersecting)), { root: el.closest('.fviewer-body'), rootMargin: NEAR });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let live = true;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    void doc.getPage(n).then((p) => {
      if (!live || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      const scale = width / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const v = p.getViewport({ scale: scale * dpr });
      const c = canvas.current;
      c.width = Math.floor(v.width);
      c.height = Math.floor(v.height);
      c.style.width = `${Math.floor(v.width / dpr)}px`;
      c.style.height = `${Math.floor(v.height / dpr)}px`;
      setH(v.height / dpr);
      task = p.render({ canvas: c, viewport: v });
      task.promise.catch(() => {});
    });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [near, width, n]);

  return (
    <div class="fv-page" ref={box} data-page={n} style={{ width: `${width}px`, minHeight: `${h}px` }}>
      {near ? <canvas ref={canvas} aria-label={`Page ${n}`} /> : null}
    </div>
  );
}
