import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';

// Landscape A4 dimensions in mm
const A4_W = 297;
const A4_H = 210;
const PAGE_PADDING = 4; // mm padding inside each PDF page

/** Capture a single DOM element to a canvas at retina quality. */
async function captureElement(element: HTMLElement): Promise<HTMLCanvasElement> {
  return html2canvas(element, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: '#ffffff',
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
  });
}

/**
 * Place a captured canvas onto one landscape-A4 PDF page.
 * The image is scaled to fit entirely within the page (no cropping).
 */
function addCanvasToPage(pdf: jsPDF, canvas: HTMLCanvasElement): void {
  const usableW = A4_W - PAGE_PADDING * 2;
  const usableH = A4_H - PAGE_PADDING * 2;
  const imgRatio = canvas.width / canvas.height;
  const pageRatio = usableW / usableH;

  let drawW: number;
  let drawH: number;
  if (imgRatio > pageRatio) {
    // wider than the page → fit by width
    drawW = usableW;
    drawH = usableW / imgRatio;
  } else {
    // taller than the page → fit by height
    drawH = usableH;
    drawW = usableH * imgRatio;
  }

  const offsetX = PAGE_PADDING + (usableW - drawW) / 2;
  const offsetY = PAGE_PADDING + (usableH - drawH) / 2;

  pdf.addImage(
    canvas.toDataURL('image/png'),
    'PNG',
    offsetX,
    offsetY,
    drawW,
    drawH,
  );
}

/**
 * Export a single DOM element as a one-page landscape-A4 PDF.
 * Kept for backward compatibility with simple single-section exports.
 */
export async function exportElementToPdf(
  element: HTMLElement,
  filename = 'report.pdf',
): Promise<void> {
  const canvas = await captureElement(element);
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  addCanvasToPage(pdf, canvas);
  pdf.save(filename);
}

/**
 * Export multiple DOM elements — one per PDF page — as a single landscape-A4 PDF.
 * Designed for multi-page dashboards where each dashboard page becomes one PDF page.
 *
 * @param pages  Array of { element, label? } for each dashboard page.
 *               Elements must already be rendered and visible in the DOM.
 * @param filename  Output file name.
 */
export async function exportMultiPageToPdf(
  pages: Array<{ element: HTMLElement; label?: string }>,
  filename = 'report.pdf',
): Promise<void> {
  if (pages.length === 0) return;

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  for (let i = 0; i < pages.length; i++) {
    if (i > 0) pdf.addPage('a4', 'landscape');
    const canvas = await captureElement(pages[i].element);
    addCanvasToPage(pdf, canvas);
  }

  pdf.save(filename);
}

/**
 * Build a multi-page PDF by calling a callback for each page index.
 * The callback should switch the visible page and return the element to capture.
 * This is useful when the same DOM node is reused across pages (e.g. public dashboards).
 */
export async function captureAndBuildPdf(
  pageCount: number,
  getElement: (pageIndex: number) => Promise<HTMLElement | null>,
  filename = 'report.pdf',
): Promise<void> {
  if (pageCount === 0) return;

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  for (let i = 0; i < pageCount; i++) {
    if (i > 0) pdf.addPage('a4', 'landscape');
    const el = await getElement(i);
    if (el) {
      const canvas = await captureElement(el);
      addCanvasToPage(pdf, canvas);
    }
  }

  pdf.save(filename);
}
