/**
 * Shared Excel report formatting utilities.
 * Provides auto-width, text wrapping, row height, font scaling, and
 * professional layout helpers for all ExcelJS reports.
 */

/**
 * Format a worksheet for professional readability:
 * - Auto-fit column widths based on content
 * - Enable text wrapping on all data cells
 * - Auto-adjust row heights for wrapped content
 * - Scale font down slightly for long text that would otherwise overflow
 * - Apply consistent header styling
 * - Enable print layout (A4, fit-to-width)
 */
function formatWorksheet(ws, opts = {}) {
  const {
    minColWidth = 6,
    maxColWidth = 30,
    defaultFontSize = 10,
    headerRowNum = null,
    dataStartRow = null,
    wrapText = true,
    autoRowHeight = true,
    printLandscape = false,
    repeatHeaderRows = null,
  } = opts;

  // 1. Auto-fit column widths based on content
  autoFitColumns(ws, { minColWidth, maxColWidth, dataStartRow });

  // 2. Apply text wrapping and auto row height to all data cells
  const startRow = dataStartRow || 1;
  for (let rowNum = startRow; rowNum <= ws.rowCount; rowNum++) {
    const row = ws.getRow(rowNum);
    if (!row || !row.values || row.values.length === 0) continue;

    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      // Enable text wrapping
      if (wrapText) {
        cell.alignment = {
          ...cell.alignment,
          wrapText: true,
          vertical: cell.alignment?.vertical || 'top',
        };
      }

      // Scale font for long text in narrow columns
      const col = ws.getColumn(colNum);
      const colWidth = col.width || 10;
      const cellText = String(cell.value || '');
      if (cellText.length > colWidth * 1.5 && cellText.length > 30) {
        const scaleFactor = Math.max(0.7, (colWidth * 1.5) / cellText.length);
        const currentSize = cell.font?.size || defaultFontSize;
        cell.font = {
          ...cell.font,
          size: Math.max(8, Math.round(currentSize * scaleFactor)),
        };
      }
    });

    // Auto-adjust row height for wrapped content
    if (autoRowHeight) {
      autoRowHeightFn(row, ws);
    }
  }

  // 3. Print layout
  ws.pageSetup = {
    ...ws.pageSetup,
    paperSize: 9, // A4
    orientation: printLandscape ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0, // unlimited pages
    margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  };

  // 4. Repeat header rows on every printed page
  if (repeatHeaderRows && repeatHeaderRows.length > 0) {
    ws.pageSetup.printArea = undefined; // clear any existing print area
    ws.pageSetup.repeatRows = `${repeatHeaderRows[0]}:${repeatHeaderRows[repeatHeaderRows.length - 1]}`;
  }

  // 5. Header row styling
  if (headerRowNum) {
    const headerRow = ws.getRow(headerRowNum);
    if (headerRow) {
      headerRow.font = { bold: true, size: 10 };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
      headerRow.alignment = { ...headerRow.alignment, wrapText: true, vertical: 'middle' };
      headerRow.height = 20;
    }
  }
}

/**
 * Auto-fit column widths based on cell content.
 * Uses the longest value in each column (up to maxColWidth).
 */
function autoFitColumns(ws, opts = {}) {
  const { minColWidth = 8, maxColWidth = 40, dataStartRow = null } = opts;
  const startRow = dataStartRow || 1;

  ws.columns.forEach((colDef, colIdx) => {
    const col = ws.getColumn(colIdx + 1);
    let maxWidth = minColWidth;

    for (let rowNum = startRow; rowNum <= ws.rowCount; rowNum++) {
      const row = ws.getRow(rowNum);
      if (!row) continue;
      const cell = row.getCell(colIdx + 1);
      if (!cell || cell.value == null) continue;
      const cellText = String(cell.value);
      // Estimate width: average character width ~1.2 units
      const estimatedWidth = Math.min(maxColWidth, Math.max(minColWidth, cellText.length * 1.1 + 2));
      maxWidth = Math.max(maxWidth, estimatedWidth);
    }

    col.width = Math.min(maxColWidth, Math.max(minColWidth, maxWidth));
  });
}

/**
 * Auto-adjust row height based on wrapped content.
 * Estimates: ~13 points per line, ~1.1 chars per unit width.
 */
function autoRowHeightFn(row, ws) {
  let maxLines = 1;
  row.eachCell({ includeEmpty: false }, (cell, colNum) => {
    const col = ws.getColumn(colNum);
    const colWidth = col.width || 10;
    const cellText = String(cell.value || '');
    if (cellText.length > 0) {
      const charsPerLine = Math.max(1, Math.floor(colWidth * 1.1));
      const lines = Math.ceil(cellText.length / charsPerLine);
      maxLines = Math.max(maxLines, lines);
    }
  });
  const minHeight = 13;
  const calculatedHeight = Math.max(minHeight, maxLines * 13);
  if (!row.height || row.height < calculatedHeight) {
    row.height = calculatedHeight;
  }
}

/**
 * Add a logo + title header to a worksheet.
 * Returns the next available row number after the header.
 */
function addReportHeader(workbook, ws, title, colSpan, logoPath, logoExtension) {
  // Row 1: Logo (compact)
  ws.insertRow(1, []);
  ws.mergeCells(`A1:${colSpan}1`);
  ws.getRow(1).height = 70;
  if (logoPath) {
    try {
      const imageId = workbook.addImage({ filename: logoPath, extension: logoExtension });
      // Center the logo horizontally across the merged columns.
      // colSpan is a letter (A=1, B=2, ..., M=13). Each Excel column ≈ 8 units wide.
      // Logo is 60px; center offset = (totalWidth - logoWidth) / 2 in column units.
      const colNum = colSpan.charCodeAt(0) - 64; // A=1, B=2, ...
      const totalWidthUnits = colNum * 8;
      const centerCol = Math.max(0, (totalWidthUnits - 60) / 16);
      ws.addImage(imageId, { tl: { col: centerCol, row: 0.1 }, ext: { width: 60, height: 60 } });
    } catch (_) { /* logo missing — continue without */ }
  }

  // Row 2: Company name
  ws.insertRow(2, ['GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS']);
  ws.mergeCells(`A2:${colSpan}2`);
  ws.getCell('A2').font = { bold: true, size: 12 };
  ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 18;

  // Row 3: Report title
  ws.insertRow(3, [title]);
  ws.mergeCells(`A3:${colSpan}3`);
  ws.getCell('A3').font = { bold: true, size: 11 };
  ws.getCell('A3').alignment = { horizontal: 'center' };
  ws.getRow(3).height = 16;

  // Row 4: metadata (caller fills)
  ws.insertRow(4, []);

  return 5; // next row number (no extra blank row)
}

/**
 * Add a summary section immediately after the data rows.
 * Each summary row has a label in column A and a value in the last column.
 * Returns the next available row number.
 */
function addSummarySection(ws, startRow, title, entries, colSpan) {
  let rowNum = startRow;
  // Title
  const titleRow = ws.insertRow(rowNum, [title]);
  ws.mergeCells(`A${rowNum}:${colSpan}${rowNum}`);
  titleRow.font = { bold: true, size: 10, color: { argb: 'FF1A4B8C' } };
  titleRow.height = 14;
  rowNum++;

  for (const [label, value] of entries) {
    const r = ws.insertRow(rowNum, [label]);
    const valueCell = r.getCell(colSpan);
    valueCell.value = value;
    r.getCell(1).font = { bold: true, size: 9 };
    valueCell.font = { bold: true, size: 9 };
    valueCell.alignment = { horizontal: 'right' };
    r.height = 13;
    rowNum++;
  }
  return rowNum;
}

/**
 * Format a number as KES with comma separators.
 */
function formatKes(n) {
  return Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
}

module.exports = {
  formatWorksheet,
  autoFitColumns,
  addReportHeader,
  addSummarySection,
  formatKes,
};
