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
 * - Apply consistent header styling (optional)
 * - Freeze the column headings under the header row (compact headers only)
 * - Enable print layout (A4, fit-to-width, repeating header rows)
 * - Consistent number formatting for financial figures
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
    moneyCols = null,
    styleHeader = true,
    freeze = true,
  } = opts;

  // 1. Header styling FIRST so the row-height pass below can grow the row
  //    when wrapped header text needs more than the styled height.
  if (headerRowNum && styleHeader) {
    const headerRow = ws.getRow(headerRowNum);
    if (headerRow) {
      headerRow.font = { bold: true, size: 10 };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
      headerRow.alignment = { ...headerRow.alignment, wrapText: true, vertical: 'middle' };
      headerRow.height = 20;
    }
  }

  // 2. Auto-fit column widths based on content (skips merged banner/title cells)
  autoFitColumns(ws, { minColWidth, maxColWidth, dataStartRow });

  // 3. Apply text wrapping and auto row height to all data cells
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

      // Explicit money columns: readable financial number format
      if (moneyCols && moneyCols.includes(colNum) && typeof cell.value === 'number' && !cell.numFmt) {
        cell.numFmt = '#,##0.##';
      }

      // Scale font for long text in narrow columns
      const col = ws.getColumn(colNum);
      const colWidth = col.width || 10;
      const cellText = cell.value == null ? '' : String(cell.value);
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

  // 4. Consistent number formatting for unformatted large figures (>= 1000),
  //    so every report shows 4,054,340 instead of 4054340. Percent/fraction
  //    values (all < 1000) and cells with an explicit format are untouched.
  applyNumberFormats(ws, startRow, moneyCols);

  // 5. Print layout
  ws.pageSetup = {
    ...ws.pageSetup,
    paperSize: 9, // A4
    orientation: printLandscape ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0, // unlimited pages
    margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  };

  // 6. Repeat header rows on every printed page. NOTE: ExcelJS only
  //    serialises `printTitlesRow` into the file — `repeatRows` is silently
  //    dropped, so always write printTitlesRow.
  if (repeatHeaderRows && repeatHeaderRows.length > 0) {
    const first = repeatHeaderRows[0];
    const last = repeatHeaderRows[repeatHeaderRows.length - 1];
    ws.pageSetup.printTitlesRow = `${first}:${last}`;
  }

  // 7. Freeze the column headings so they stay visible while scrolling.
  //    ExcelJS can only freeze a contiguous block from row 1, so only do it
  //    when the header sits near the top (compact report letterhead).
  if (freeze && headerRowNum && headerRowNum <= 6) {
    if (!ws.views || ws.views.length === 0) {
      ws.views = [
        { state: 'frozen', ySplit: headerRowNum, xSplit: 0, activeCell: `A${headerRowNum + 1}` },
      ];
    }
  }
}

/**
 * Auto-fit column widths based on cell content.
 * Uses the longest value in each column (up to maxColWidth).
 * Merged cells (title/banner rows) are skipped — their text spans the whole
 * merged range, so it must not inflate any single column.
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
      if (!cell || cell.value == null || cell.value === '') continue;
      if (cell.isMerged) continue;
      const cellText = typeof cell.value === 'number'
        ? cell.value.toLocaleString('en-US', { maximumFractionDigits: 2 })
        : String(cell.value);
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
 * Merged cells (banners, notes) are measured against the FULL merged width,
 * not one column, so section rows get the height they actually need.
 */
function autoRowHeightFn(row, ws) {
  let maxLines = 1;
  row.eachCell({ includeEmpty: false }, (cell, colNum) => {
    const cellText = cell.value == null ? '' : String(cell.value);
    if (cellText.length === 0) return;

    let charsPerLine;
    if (cell.isMerged) {
      // Excel merges are keyed by the master cell address (where the value
      // lives) with 1-based row/col bounds — measure across the whole range.
      const merge = ws._merges && ws._merges[cell.address];
      if (!merge || !merge.model) return;
      let totalWidth = 0;
      for (let c = merge.model.left; c <= merge.model.right; c++) {
        totalWidth += ws.getColumn(c).width || 10;
      }
      charsPerLine = Math.max(1, Math.floor(totalWidth * 1.1));
    } else {
      const colWidth = ws.getColumn(colNum).width || 10;
      charsPerLine = Math.max(1, Math.floor(colWidth * 1.1));
    }

    const lines = Math.ceil(cellText.length / charsPerLine);
    maxLines = Math.max(maxLines, lines);
  });
  const minHeight = 13;
  const calculatedHeight = Math.max(minHeight, maxLines * 13);
  if (!row.height || row.height < calculatedHeight) {
    row.height = calculatedHeight;
  }
}

/**
 * Consistent number formatting across reports:
 * - cells in `moneyCols` always get a thousands-separated format
 * - other numeric cells get it when |value| >= 1000 (so fractions/percents
 *   below 1000 keep their natural display)
 * - cells that already carry an explicit numFmt are never overwritten
 */
function applyNumberFormats(ws, startRow, moneyCols = null) {
  const NUM_FMT = '#,##0.##';
  for (let rowNum = startRow; rowNum <= ws.rowCount; rowNum++) {
    const row = ws.getRow(rowNum);
    if (!row) continue;
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      if (cell.numFmt) return;
      if (typeof cell.value !== 'number' || !isFinite(cell.value)) return;
      if (moneyCols && moneyCols.includes(colNum)) {
        cell.numFmt = NUM_FMT;
      } else if (Math.abs(cell.value) >= 1000) {
        cell.numFmt = NUM_FMT;
      }
    });
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
 * Finish a multi-section sheet that has its own coloured headers/branding:
 * auto-fit + wrap + row heights + number formats + print layout, WITHOUT
 * restyling the existing header and WITHOUT freezing (headers sit mid-sheet).
 */
function finishSheet(ws, opts = {}) {
  const {
    headerRowNum = null,
    dataStartRow = null,
    landscape = true,
    repeatHeaders = true,
    maxColWidth = 30,
    moneyCols = null,
  } = opts;
  formatWorksheet(ws, {
    dataStartRow: dataStartRow || headerRowNum || 6,
    headerRowNum,
    styleHeader: false,
    freeze: false,
    printLandscape: landscape,
    maxColWidth,
    moneyCols,
    repeatHeaderRows: repeatHeaders && headerRowNum ? [headerRowNum] : null,
  });
}

/**
 * Format a number as KES with comma separators.
 */
function formatKes(n) {
  return Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
}

module.exports = {
  formatWorksheet,
  finishSheet,
  autoFitColumns,
  applyNumberFormats,
  addReportHeader,
  addSummarySection,
  formatKes,
};
