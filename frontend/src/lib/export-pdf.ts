import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';

/**
 * Capture a DOM element as a PDF (screenshot-style) and trigger download.
 * Uses html2canvas to rasterise the element, then lays it onto a jsPDF page
 * that matches the captured aspect ratio.
 */
export async function exportElementToPdf(
  element: HTMLElement,
  filename = 'report.pdf',
): Promise<void> {
  // Force all lazy / intersection-observer charts to render before capture
  const lazyPlaceholders = element.querySelectorAll('[data-lazy-chart]');
  lazyPlaceholders.forEach((el) => el.setAttribute('data-force-visible', 'true'));

  const canvas = await html2canvas(element, {
    scale: 2, // retina quality
    useCORS: true, // allow cross-origin images (chart icons, etc.)
    logging: false,
    backgroundColor: '#ffffff',
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
  });

  const imgWidth = canvas.width;
  const imgHeight = canvas.height;

  // A4 width in mm = 210, but we use the captured aspect ratio
  const pdfWidth = 297; // landscape A4 width mm
  const pdfHeight = (imgHeight * pdfWidth) / imgWidth;

  // If the content is taller than a single page, split into multiple pages
  const pageHeight = 210; // landscape A4 height mm
  const totalPages = Math.ceil(pdfHeight / pageHeight);

  const pdf = new jsPDF({
    orientation: pdfHeight > pdfWidth ? 'portrait' : 'landscape',
    unit: 'mm',
    format: totalPages === 1 ? [pdfWidth, pdfHeight] : [pdfWidth, pageHeight],
  });

  if (totalPages === 1) {
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pdfWidth, pdfHeight);
  } else {
    // Multi-page: slice the canvas vertically
    const sliceHeightPx = (pageHeight / pdfWidth) * imgWidth;
    for (let i = 0; i < totalPages; i++) {
      if (i > 0) pdf.addPage([pdfWidth, pageHeight]);

      const srcY = i * sliceHeightPx;
      const srcH = Math.min(sliceHeightPx, imgHeight - srcY);
      const destH = (srcH * pdfWidth) / imgWidth;

      // Draw a slice of the original canvas onto a temp canvas
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = imgWidth;
      sliceCanvas.height = srcH;
      const ctx = sliceCanvas.getContext('2d')!;
      ctx.drawImage(canvas, 0, srcY, imgWidth, srcH, 0, 0, imgWidth, srcH);

      pdf.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', 0, 0, pdfWidth, destH);
    }
  }

  pdf.save(filename);
}
