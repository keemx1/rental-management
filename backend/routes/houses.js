const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ExcelJS = require('exceljs');
const whatsapp = require('../config/whatsapp');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const { streamWorkbook, sendExcelReport } = require('../services/excelStream');
const { resolveLogoPath, getLogoExtension } = require('../services/logo');
const { reportDocumentName, renameForDelivery } = require('../services/docNames');
const { formatWorksheet } = require('../services/excelFormat');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const rawHouses = await store.listHouses(req.query);
    const houses = [];
    for (const h of rawHouses) {
      const tenants = await store.listTenants({ house_id: h.id });
      houses.push({
        ...h,
        clients_count: tenants.length,
      });
    }
    res.json({ houses });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list houses' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const house = await store.getHouse(req.params.id);
    if (!house) return res.status(404).json({ error: 'House not found' });
    res.json({ house });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get house' });
  }
});

router.get('/:id/dashboard', async (req, res) => {
  try {
    const selectedHouse = await store.getHouse(req.params.id);
    if (!selectedHouse) return res.status(404).json({ error: 'House not found' });

    const buildingHouses = [selectedHouse];
    const buildingTenants = await store.listTenants({ house_id: selectedHouse.id, exclude_vacant: false });

    // Payment state from the canonical rent-cycle counters (rent_paid_this_
    // month / arrears), which approval, reconciliation and recalculation all
    // maintain from complete approved payment history. Summing this calendar
    // month's raw payments mis-labelled arrears/deposit settlements as rent
    // and showed paid-up tenants (whose cycle rolled forward) as unpaid.
    const tenants = buildingTenants.map((t) => {
      const rentAmount = Number(t.rent_amount || 0);
      const rentPaid = Number(t.rent_paid_this_month || 0);
      const arrears = Number(t.arrears || 0);
      let payment_state = 'Unpaid';
      if (arrears > 0) {
        payment_state = 'Arrears';
      } else if (rentAmount > 0 && rentPaid >= rentAmount) {
        payment_state = 'Paid';
      } else if (rentPaid > 0) {
        payment_state = 'Partial';
      }
      return {
        ...t,
        payment_state,
      };
    });

    const occupiedTenants = tenants.filter((t) => t.status !== 'Vacant');
    const totalUnits = selectedHouse.total_units || 1;
    // Units under a live RESERVED booking are unavailable — exclude them
    // from the vacant count/list until cancelled or activated.
    const { getReservedUnits } = require('../storage/futureTenancies');
    const unitKeyOf = (t) => String(t.unit_label || t.tenant_code || t.id || '').trim().toLowerCase();
    const occupiedKeys = new Set(occupiedTenants.map(unitKeyOf));
    let reservedUnits = [];
    try {
      reservedUnits = await getReservedUnits(selectedHouse.paybill_number);
    } catch (_) { reservedUnits = []; }
    const isReservedUnit = (t) => reservedUnits.some((r) =>
      String(r.unit_label || r.tenant_code || '').trim().toLowerCase() === unitKeyOf(t)
    );
    // Reserved units without any tenant row are inside the derived
    // (total − occupied) count too — exclude each unoccupied one once.
    const unoccupiedReserved = reservedUnits.filter((r) =>
      !occupiedKeys.has(String(r.unit_label || r.tenant_code || '').trim().toLowerCase())
    ).length;
    const vacantUnitsCount = Math.max(0, totalUnits - occupiedTenants.length - unoccupiedReserved);
    const vacantUnitsList = tenants.filter((t) => t.status === 'Vacant' && !isReservedUnit(t));

    // Maintenance charges for this property
    const { pool } = require('../config/database');
    const mcRes = await pool.query(
      `SELECT mc.* FROM maintenance_charges mc
       JOIN work_orders wo ON mc.work_order_id = wo.id
       WHERE wo.house_paybill_number = $1`,
      [selectedHouse.id]
    );
    const allCharges = mcRes.rows;
    const mcMgmt = allCharges.filter(c => {
      const p = String(c.responsible_party || '').toLowerCase();
      return p.includes('management') || p.includes('owner');
    });
    const mcTenant = allCharges.filter(c => {
      const p = String(c.responsible_party || '').toLowerCase();
      return p.includes('tenant');
    });
    const mcTotalExpenses = allCharges.reduce((s, c) => s + Number(c.total_cost || 0), 0);
    const mcMgmtExpenses = mcMgmt.reduce((s, c) => s + Number(c.total_cost || 0), 0);
    const mcTenantResponsible = mcTenant.reduce((s, c) => s + Number(c.total_cost || 0), 0);
    const mcRecovered = mcTenant.reduce((s, c) => s + Number(c.amount_recovered || 0), 0);
    const mcOutstanding = mcTenantResponsible - mcRecovered;

    res.json({
      building: {
        house_name: selectedHouse.house_name,
        selected_house_id: selectedHouse.id,
        total_units: totalUnits,
        total_clients: occupiedTenants.length,
        vacant_units: vacantUnitsCount,
        paid_tenants: occupiedTenants.filter((t) => t.payment_state === 'Paid').length,
        unpaid_tenants: occupiedTenants.filter((t) => t.payment_state !== 'Paid').length,
        maintenance: {
          total_expenses: mcTotalExpenses,
          management_paid: mcMgmtExpenses,
          tenant_responsible: mcTenantResponsible,
          recovered: mcRecovered,
          outstanding: mcOutstanding,
          total_issues: allCharges.length,
        },
      },
      tenants,
      vacant_units_list: vacantUnitsList,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load house dashboard' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { house_name, total_units, paybill_number, notes, garbage_fee_enabled, payment_method, payment_paybill, account_number_format, till_number } = req.body;
    if (!house_name || total_units == null || !paybill_number) {
      return res.status(400).json({ error: 'house_name, total_units, paybill_number required' });
    }
    const housesList = await store.listHouses();
    const duplicate = housesList.find(
      (h) => h.paybill_number === paybill_number || `${h.house_name}:${h.total_units}` === `${house_name}:${total_units}`
    );
    if (duplicate) return res.status(409).json({ error: 'House already exists' });
    const house = await store.createHouse({ house_name, total_units, paybill_number, notes, garbage_fee_enabled: !!garbage_fee_enabled, payment_method: payment_method || 'paybill', payment_paybill: payment_paybill || null, account_number_format: account_number_format || null, till_number: till_number || null });
    res.status(201).json({ house });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create house' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const allowed = ['house_name', 'total_units', 'paybill_number', 'occupancy_status', 'notes', 'garbage_fee_enabled', 'payment_method', 'payment_paybill', 'account_number_format', 'till_number', 'till_name'];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (patch.occupancy_status !== undefined) {
      const ok = ['unknown', 'vacant', 'occupied'].includes(String(patch.occupancy_status));
      if (!ok) return res.status(400).json({ error: 'occupancy_status must be one of: unknown, vacant, occupied' });
    }
    const house = await store.updateHouse(req.params.id, patch);
    if (!house) return res.status(404).json({ error: 'House not found' });
    res.json({ house });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update house: ' + err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await store.deleteHouse(req.params.id);
    if (!result.ok) {
      return res.status(result.reason === 'House not found' ? 404 : 409).json({ error: result.reason });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete house' });
  }
});

router.post('/send-vacant-report', async (req, res) => {
  try {
    const { phone_number, house_id, mode } = req.body;
    if (mode !== 'download' && !phone_number) {
      return res.status(400).json({ error: 'Phone number required' });
    }

    let rawHouses;
    if (house_id) {
      const h = await store.getHouse(house_id);
      if (!h) return res.status(404).json({ error: 'House not found' });
      rawHouses = [h];
    } else {
      rawHouses = await store.listHouses({});
    }
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Vacant Houses Report');

    worksheet.columns = [
      { key: 'house', width: 30 },
      { key: 'unit_number', width: 20 },
      { key: 'total_units', width: 15 },
      { key: 'occupied', width: 15 },
      { key: 'vacant', width: 15 }
    ];

    worksheet.insertRow(1, []);
    worksheet.mergeCells('A1:E1');
    // Compact letterhead (70pt) so the frozen header stays usable.
    worksheet.getRow(1).height = 70;

    const logoPath = resolveLogoPath();
    if (logoPath) {
      const imageId = workbook.addImage({
        filename: logoPath,
        extension: getLogoExtension(),
      });
      worksheet.addImage(imageId, {
        tl: { col: 1.8, row: 0.1 },
        ext: { width: 60, height: 60 }
      });
    }

    worksheet.insertRow(2, ['GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS VACANCY REPORT']);
    worksheet.mergeCells('A2:E2');
    worksheet.getCell('A2').font = { bold: true, size: 14 };
    worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(2).height = 24;

    worksheet.insertRow(3, []);

    const headerRow = worksheet.insertRow(4, ['House Name', 'Vacant Unit', 'Total Units', 'Occupied Units', 'Vacant Units']);
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };

    let totalSystemUnits = 0;
    let totalOccupied = 0;
    let totalVacant = 0;

    for (const h of rawHouses) {
      const tenants = await store.listTenants({ house_id: h.id, exclude_vacant: false });
      const occupied = tenants.filter(t => t.status !== 'Vacant').length;
      // Reserved units are unavailable — exclude from vacant rows/counts.
      const { getReservedUnits } = require('../storage/futureTenancies');
      let reservedUnits = [];
      try {
        reservedUnits = await getReservedUnits(h.paybill_number || h.id);
      } catch (_) { reservedUnits = []; }
      const occupiedKeys = new Set(
        tenants.filter(t => t.status !== 'Vacant')
          .map(t => String(t.unit_label || t.tenant_code || t.id || '').trim().toLowerCase())
      );
      const isReservedUnit = (t) => reservedUnits.some((r) =>
        String(r.unit_label || r.tenant_code || '').trim().toLowerCase() ===
        String(t.unit_label || t.tenant_code || t.id || '').trim().toLowerCase()
      );
      const unoccupiedReserved = reservedUnits.filter((r) =>
        !occupiedKeys.has(String(r.unit_label || r.tenant_code || '').trim().toLowerCase())
      ).length;
      const vacantCount = Math.max(0, h.total_units - occupied - unoccupiedReserved);
      const vacantTenants = tenants.filter(t => t.status === 'Vacant' && !isReservedUnit(t));

      if (vacantTenants.length > 0) {
        for (const vt of vacantTenants) {
          worksheet.addRow({
            house: h.house_name,
            unit_number: vt.tenant_code || '—',
            total_units: h.total_units,
            occupied: occupied,
            vacant: vacantCount
          });
        }
      } else {
        worksheet.addRow({
          house: h.house_name,
          unit_number: '—',
          total_units: h.total_units,
          occupied: occupied,
          vacant: vacantCount
        });
      }

      totalSystemUnits += Number(h.total_units) || 0;
      totalOccupied += occupied;
      totalVacant += vacantCount;
    }

    worksheet.addRow([]);
    const totalRow = worksheet.addRow({
      house: 'GRAND TOTAL',
      unit_number: '',
      total_units: totalSystemUnits,
      occupied: totalOccupied,
      vacant: totalVacant
    });
    totalRow.font = { bold: true };

    // Auto-fit widths, wrap text, auto row heights, frozen header row,
    // A4 print layout with repeating column headings.
    formatWorksheet(worksheet, { dataStartRow: 4, headerRowNum: 4, printLandscape: false, repeatHeaderRows: [4] });

    const docName = reportDocumentName({ type: 'Vacancy_Report', houseName: rawHouses.length === 1 ? rawHouses[0].house_name : '', date: new Date() });

    if (mode === 'download') {
      return streamWorkbook(res, workbook, 'Vacancy_Report', 'Vacancy_Report', docName);
    }

    // Same generation + delivery pipeline as every other report send.
    await sendExcelReport(phone_number, workbook, docName, 'Here is the requested Excel vacancy report.');

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    if (err && err.reportStage === 'send') {
      return res.status(502).json({
        stage: 'send',
        error: 'Report was generated successfully, but WhatsApp delivery failed: ' + err.message,
      });
    }
    res.status(500).json({ stage: 'generate', error: 'Failed to generate and send vacancy report' });
  }
});

module.exports = router;
