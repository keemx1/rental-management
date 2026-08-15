const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ExcelJS = require('exceljs');
const whatsapp = require('../config/whatsapp');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const { streamWorkbook } = require('../services/excelStream');
const { resolveLogoPath, getLogoExtension } = require('../services/logo');
const { reportDocumentName, renameForDelivery } = require('../services/docNames');

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
    const payments = await store.listPayments({ status: 'Approved' });

    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthPayments = payments.filter((p) => String(p.payment_date || '').startsWith(currentMonth));

    const tenantPaidTotals = {};
    for (const p of monthPayments) {
      const tid = String(p.tenant_id);
      tenantPaidTotals[tid] = (tenantPaidTotals[tid] || 0) + Number(p.amount || 0);
    }

    const tenants = buildingTenants.map((t) => {
      const tid = String(t.id);
      const totalPaid = tenantPaidTotals[tid] || 0;
      const rentDue = Number(t.rent_amount || 0);
      const arrears = Number(t.arrears || 0);
      let payment_state = 'Unpaid';
      if (arrears > 0) {
        payment_state = 'Arrears';
      } else if (totalPaid >= rentDue && rentDue > 0) {
        payment_state = 'Paid';
      } else if (totalPaid > 0) {
        payment_state = 'Partial';
      }
      return {
        ...t,
        payment_state,
      };
    });

    const occupiedTenants = tenants.filter((t) => t.status !== 'Vacant');
    const totalUnits = selectedHouse.total_units || 1;
    const vacantUnitsCount = Math.max(0, totalUnits - occupiedTenants.length);
    const vacantUnitsList = tenants.filter((t) => t.status === 'Vacant');

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
    worksheet.getRow(1).height = 140;

    const logoPath = resolveLogoPath();
    if (logoPath) {
      const imageId = workbook.addImage({
        filename: logoPath,
        extension: getLogoExtension(),
      });
      worksheet.addImage(imageId, {
        tl: { col: 1.8, row: 0.1 },
        ext: { width: 120, height: 120 }
      });
    }

    worksheet.insertRow(2, ['GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS VACANCY REPORT']);
    worksheet.mergeCells('A2:E2');
    worksheet.getCell('A2').font = { bold: true, size: 14 };
    worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(2).height = 30;

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
      const vacantCount = Math.max(0, h.total_units - occupied);
      const vacantTenants = tenants.filter(t => t.status === 'Vacant');

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
    
    const docName = reportDocumentName({ type: 'Vacancy_Report', houseName: rawHouses.length === 1 ? rawHouses[0].house_name : '', date: new Date() });

    if (mode === 'download') {
      return streamWorkbook(res, workbook, 'Vacancy_Report', 'Vacancy_Report', docName);
    }

    const tempFilePath = path.join(os.tmpdir(), `Vacancy_Report_${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(tempFilePath);
    const deliveryPath = renameForDelivery(tempFilePath, docName);

    await whatsapp.sendMediaMessage(phone_number, deliveryPath, 'Here is the requested Excel vacancy report.');
    
    fs.unlinkSync(deliveryPath);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate and send vacancy report' });
  }
});

module.exports = router;
