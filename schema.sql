-- Rental Messaging — Supabase schema (run when connecting DATABASE_URL)

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_code VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  house_paybill_number VARCHAR(32) NULL,
  property_name VARCHAR(128) NOT NULL DEFAULT 'General',
  unit_label VARCHAR(64) NULL,
  rent_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  rent_due_date DATE NOT NULL,
  rent_due_time TIME NOT NULL DEFAULT '23:59:00',
  arrears DECIMAL(10, 2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR(32) NOT NULL REFERENCES tenants(tenant_code) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  mpesa_reference VARCHAR(64) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ NULL,
  notes TEXT NULL
);

CREATE TABLE IF NOT EXISTS message_logs (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR(32) NULL REFERENCES tenants(tenant_code) ON DELETE SET NULL,
  message_type VARCHAR(64) NOT NULL,
  message_body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS houses (
  paybill_number VARCHAR(32) PRIMARY KEY,
  house_name VARCHAR(128) NOT NULL,
  total_units INTEGER NOT NULL DEFAULT 1,
  occupancy_status VARCHAR(20) NOT NULL DEFAULT 'unknown',
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'houses' AND column_name = 'occupancy_status'
  ) THEN
    ALTER TABLE houses
      ADD COLUMN occupancy_status VARCHAR(20) NOT NULL DEFAULT 'unknown';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS message_templates (
  id SERIAL PRIMARY KEY,
  key VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_tenants_house_paybill'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT fk_tenants_house_paybill
      FOREIGN KEY (house_paybill_number)
      REFERENCES houses(paybill_number)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tenants_due ON tenants (rent_due_date);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);

-- Arrears: carry-forward balance for unpaid/partial rent
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'arrears'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN arrears DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Deposit tracking
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'deposit_amount'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN deposit_amount DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'deposit_paid'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN deposit_paid DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Payment type: 'rent' or 'deposit'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'payment_type'
  ) THEN
    ALTER TABLE payments
      ADD COLUMN payment_type VARCHAR(20) NOT NULL DEFAULT 'rent';
  END IF;
END $$;

-- Penalties / Invoices for repairs, damages, extra charges
CREATE TABLE IF NOT EXISTS penalties (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR(32) NOT NULL REFERENCES tenants(tenant_code) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Paid')),
  paid_date DATE NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Invoice category: penalty / maintenance / service (other charges)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'penalties' AND column_name = 'category'
  ) THEN
    ALTER TABLE penalties
      ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'penalty' CHECK (category IN ('penalty', 'maintenance', 'other'));
  END IF;
END $$;

-- Lifetime invoice number: unique, permanent, traceable
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'penalties' AND column_name = 'invoice_number'
  ) THEN
    ALTER TABLE penalties
      ADD COLUMN invoice_number VARCHAR(40) NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_penalties_invoice_number ON penalties (invoice_number);

CREATE INDEX IF NOT EXISTS idx_penalties_tenant ON penalties (tenant_code);
CREATE INDEX IF NOT EXISTS idx_penalties_status ON penalties (status);

-- Move-in date for tenants
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'move_in_date'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN move_in_date DATE NULL;
  END IF;
END $$;

-- Garbage fee on houses (whether this house charges garbage fee)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'houses' AND column_name = 'garbage_fee_enabled'
  ) THEN
    ALTER TABLE houses
      ADD COLUMN garbage_fee_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- Garbage fee tracking on tenants
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'garbage_fee_amount'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN garbage_fee_amount DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'garbage_fee_paid'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN garbage_fee_paid DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'rent_paid_this_month'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN rent_paid_this_month DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- WhatsApp delivery tracking
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'message_logs' AND column_name = 'whatsapp_message_id'
  ) THEN
    ALTER TABLE message_logs
      ADD COLUMN whatsapp_message_id VARCHAR(255) NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'message_logs' AND column_name = 'failure_reason'
  ) THEN
    ALTER TABLE message_logs
      ADD COLUMN failure_reason TEXT NULL;
  END IF;
END $$;

-- Credit balance: tenant overpayment stored as credit
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'credit_balance'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN credit_balance DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Advance rent: date up to which rent has been prepaid
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'advance_rent_until'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN advance_rent_until DATE NULL;
  END IF;
END $$;

-- Advance rent: remaining partial-month amount after full months
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'advance_rent_balance'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN advance_rent_balance DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Receipt number: unique permanent receipt for each approved payment
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'receipt_number'
  ) THEN
    ALTER TABLE payments
      ADD COLUMN receipt_number VARCHAR(32) NULL;
  END IF;
END $$;

-- Receipt counters: tracks sequence numbers for receipt generation
CREATE TABLE IF NOT EXISTS receipt_counters (
  prefix VARCHAR(20) PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1
);

-- Initialize counters if empty
INSERT INTO receipt_counters (prefix, next_number) VALUES ('GEHPM', 1) ON CONFLICT (prefix) DO NOTHING;
INSERT INTO receipt_counters (prefix, next_number) VALUES ('GEHPM-RCT', 1) ON CONFLICT (prefix) DO NOTHING;
INSERT INTO receipt_counters (prefix, next_number) VALUES ('GHPM', 1) ON CONFLICT (prefix) DO NOTHING;
INSERT INTO receipt_counters (prefix, next_number) VALUES ('GHPM-TEST', 1) ON CONFLICT (prefix) DO NOTHING;

-- Invoice counters: lifetime-continuous sequence for invoice numbers (separate from receipts)
CREATE TABLE IF NOT EXISTS invoice_counters (
  prefix VARCHAR(20) PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1
);

INSERT INTO invoice_counters (prefix, next_number) VALUES ('GEHPM-INV', 1) ON CONFLICT (prefix) DO NOTHING;

-- Statement counters: lifetime-continuous sequence for tenant statement numbers
CREATE TABLE IF NOT EXISTS statement_counters (
  prefix VARCHAR(20) PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1
);

INSERT INTO statement_counters (prefix, next_number) VALUES ('GEHPM-STMT', 1) ON CONFLICT (prefix) DO NOTHING;

-- App config: stores system-wide settings
CREATE TABLE IF NOT EXISTS app_config (
  key VARCHAR(50) PRIMARY KEY,
  value TEXT NOT NULL
);

-- Initialize receipt mode to 'test' (change to 'production' on go-live)
INSERT INTO app_config (key, value) VALUES ('receipt_mode', 'test') ON CONFLICT (key) DO NOTHING;

-- Opening advance rent: balance entered during tenant registration (migration).
-- Only one of opening arrears / opening advance rent may be set per tenant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'opening_advance_rent'
  ) THEN
    ALTER TABLE tenants ADD COLUMN opening_advance_rent DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Audit trail: records key financial actions (overpayment resolution, credit apply, etc.)
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor VARCHAR(128) NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NULL,
  entity_id VARCHAR(64) NULL,
  details TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

-- Property-level payment configuration
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'houses' AND column_name = 'payment_method'
  ) THEN
    ALTER TABLE houses ADD COLUMN payment_method VARCHAR(20) NOT NULL DEFAULT 'paybill';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'houses' AND column_name = 'payment_paybill'
  ) THEN
    ALTER TABLE houses ADD COLUMN payment_paybill VARCHAR(32);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'houses' AND column_name = 'account_number_format'
  ) THEN
    ALTER TABLE houses ADD COLUMN account_number_format TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'houses' AND column_name = 'till_number'
  ) THEN
    ALTER TABLE houses ADD COLUMN till_number VARCHAR(32);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'houses' AND column_name = 'till_name'
  ) THEN
    ALTER TABLE houses ADD COLUMN till_name VARCHAR(128);
  END IF;
END $$;

-- Document registry: every generated document (receipts, invoices, reports) is
-- recorded here so the Documents hub can search, filter, download and share it.
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  doc_type VARCHAR(32) NOT NULL,
  doc_number VARCHAR(64) NULL,
  title VARCHAR(255) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  file_path VARCHAR(512) NOT NULL,
  tenant_code VARCHAR(32) NULL REFERENCES tenants(tenant_code) ON DELETE SET NULL,
  house_paybill_number VARCHAR(32) NULL REFERENCES houses(paybill_number) ON DELETE SET NULL,
  property_name VARCHAR(128) NULL,
  unit_label VARCHAR(64) NULL,
  amount DECIMAL(10, 2) NULL,
  doc_date DATE NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_type ON documents (doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents (tenant_code);
CREATE INDEX IF NOT EXISTS idx_documents_house ON documents (house_paybill_number);
CREATE INDEX IF NOT EXISTS idx_documents_date ON documents (doc_date);

-- Lifetime-continuous counters for maintenance invoices and work orders.
-- Prefixes share the generic invoice_counters table (prefix -> next_number).
INSERT INTO invoice_counters (prefix, next_number) VALUES ('GEHPM-MNT', 1) ON CONFLICT (prefix) DO NOTHING;
INSERT INTO invoice_counters (prefix, next_number) VALUES ('GEHPM-WO', 1) ON CONFLICT (prefix) DO NOTHING;

-- Water charge tracking on tenants (included in rent invoices when applicable).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'water_charge_amount'
  ) THEN
    ALTER TABLE tenants ADD COLUMN water_charge_amount DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'water_charge_paid'
  ) THEN
    ALTER TABLE tenants ADD COLUMN water_charge_paid DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Work orders: formal repair instructions before work begins.
-- Workflow status: Pending -> Approved -> Assigned -> In Progress -> Completed.
CREATE TABLE IF NOT EXISTS work_orders (
  id SERIAL PRIMARY KEY,
  wo_number VARCHAR(32) NOT NULL UNIQUE,
  property_name VARCHAR(128) NOT NULL DEFAULT '',
  house_paybill_number VARCHAR(32) NULL REFERENCES houses(paybill_number) ON DELETE SET NULL,
  unit_codes TEXT NULL,
  caretaker_name VARCHAR(128) NULL,
  date_requested DATE NULL,
  date_work_started DATE NULL,
  date_completed DATE NULL,
  technician_name VARCHAR(128) NULL,
  technician_phone VARCHAR(32) NULL,
  date_assigned DATE NULL,
  expected_completion DATE NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Approved', 'Assigned', 'In Progress', 'Completed')),
  priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
  items JSONB NOT NULL DEFAULT '[]',
  actual_work_completed TEXT NULL,
  materials_used TEXT NULL,
  labour_involved TEXT NULL,
  total_cost DECIMAL(10, 2) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders (status);
CREATE INDEX IF NOT EXISTS idx_work_orders_house ON work_orders (house_paybill_number);

-- Maintenance invoices: repair/maintenance billing docs.
-- Items carry per-unit work with labour and material cost split.
CREATE TABLE IF NOT EXISTS maintenance_invoices (
  id SERIAL PRIMARY KEY,
  mnt_number VARCHAR(32) NOT NULL UNIQUE,
  property_name VARCHAR(128) NOT NULL DEFAULT '',
  house_paybill_number VARCHAR(32) NULL REFERENCES houses(paybill_number) ON DELETE SET NULL,
  unit_codes TEXT NULL,
  caretaker_name VARCHAR(128) NULL,
  date_reported DATE NULL,
  date_work_started DATE NULL,
  date_completed DATE NULL,
  technician_name VARCHAR(128) NULL,
  technician_phone VARCHAR(32) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Approved', 'Paid', 'Partially Paid', 'Assigned', 'In Progress', 'Completed', 'Pending Reimbursement', 'Partially Reimbursed', 'Fully Reimbursed')),
  items JSONB NOT NULL DEFAULT '[]',
  labour_total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  material_total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  grand_total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  paid_total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maint_inv_status ON maintenance_invoices (status);
CREATE INDEX IF NOT EXISTS idx_maint_inv_house ON maintenance_invoices (house_paybill_number);

-- =====================================================================
-- TENANCY LIFECYCLE / ARCHIVE MODULE
-- =====================================================================

-- Tenant lifecycle fields: national ID, move-out, notice to vacate, exit reason
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'national_id'
  ) THEN
    ALTER TABLE tenants ADD COLUMN national_id VARCHAR(64) NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'move_out_date'
  ) THEN
    ALTER TABLE tenants ADD COLUMN move_out_date DATE NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'notice_to_vacate_date'
  ) THEN
    ALTER TABLE tenants ADD COLUMN notice_to_vacate_date DATE NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'exit_reason'
  ) THEN
    ALTER TABLE tenants ADD COLUMN exit_reason TEXT NULL;
  END IF;
END $$;

-- Water charge fields are already defined above; garbage/water onboarding is
-- settled through first-payment logic (see Part 2).

-- Tenancy Archive: permanent, immutable record of every tenancy that ever existed.
-- Archived records are never deleted except by a System Administrator.
CREATE TABLE IF NOT EXISTS tenancy_archive (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR(32) NOT NULL,
  property_name VARCHAR(128) NULL,
  house_paybill_number VARCHAR(32) NULL REFERENCES houses(paybill_number) ON DELETE SET NULL,
  unit_label VARCHAR(64) NULL,
  tenant_name VARCHAR(128) NOT NULL,
  phone_number VARCHAR(20) NULL,
  national_id VARCHAR(64) NULL,
  move_in_date DATE NULL,
  move_out_date DATE NULL,
  rent_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_paid DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_refund DECIMAL(10, 2) NOT NULL DEFAULT 0,
  opening_balance DECIMAL(10, 2) NOT NULL DEFAULT 0,
  final_balance DECIMAL(10, 2) NOT NULL DEFAULT 0,
  exit_reason TEXT NULL,
  exit_invoice_number VARCHAR(40) NULL,
  payments JSONB NOT NULL DEFAULT '[]',
  penalties JSONB NOT NULL DEFAULT '[]',
  documents JSONB NOT NULL DEFAULT '[]',
  message_logs JSONB NOT NULL DEFAULT '[]',
  statements JSONB NOT NULL DEFAULT '[]',
  inspections JSONB NOT NULL DEFAULT '[]',
  exit_invoice JSONB NULL,
  financial_snapshot JSONB NOT NULL DEFAULT '{}',
  archived_by VARCHAR(128) NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archive_property ON tenancy_archive (property_name);
CREATE INDEX IF NOT EXISTS idx_archive_house ON tenancy_archive (house_paybill_number);
CREATE INDEX IF NOT EXISTS idx_archive_tenant_code ON tenancy_archive (tenant_code);
CREATE INDEX IF NOT EXISTS idx_archive_tenant_name ON tenancy_archive (tenant_name);
CREATE INDEX IF NOT EXISTS idx_archive_phone ON tenancy_archive (phone_number);
CREATE INDEX IF NOT EXISTS idx_archive_national_id ON tenancy_archive (national_id);
CREATE INDEX IF NOT EXISTS idx_archive_move_in ON tenancy_archive (move_in_date);
CREATE INDEX IF NOT EXISTS idx_archive_move_out ON tenancy_archive (move_out_date);
CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON tenancy_archive (archived_at DESC);

-- Overpayment amount computed at approval time so later resolution/skip
-- flows can read the authoritative value instead of trusting the client.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'overpayment_amount'
  ) THEN
    ALTER TABLE payments
      ADD COLUMN overpayment_amount DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Payment synchronization (Phase 1): approval is a single transaction that
-- updates and validates every module. sync_status is only 'synced' (with
-- synced_at set) after all modules updated successfully; 'pending_sync' while
-- approval is in progress or awaiting recovery; 'sync_failed' if a module
-- write/validation failed and the approval was rolled back (payment stays
-- Pending and approval is retried automatically).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'sync_status'
  ) THEN
    ALTER TABLE payments
      ADD COLUMN sync_status VARCHAR(20) NOT NULL DEFAULT 'pending_sync';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'synced_at'
  ) THEN
    ALTER TABLE payments
      ADD COLUMN synced_at TIMESTAMPTZ NULL;
  END IF;
END $$;

-- Pending overpayment allocations: excess payment approved without an
-- immediate resolution (Skip / Resolve Later). Kept until management
-- allocates it to Advance Rent or moves it to Credit Balance.
CREATE TABLE IF NOT EXISTS pending_overpayments (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR(32) NOT NULL,
  tenant_name VARCHAR(128) NOT NULL,
  property_name VARCHAR(128) NULL,
  unit_code VARCHAR(64) NULL,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  payment_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  overpayment_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  receipt_number VARCHAR(32) NULL,
  transaction_reference VARCHAR(64) NULL,
  payment_date DATE NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Pending Allocation' CHECK (status IN ('Pending Allocation', 'Resolved')),
  resolution_type VARCHAR(32) NULL,
  resolved_at TIMESTAMPTZ NULL,
  resolved_by VARCHAR(128) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_op_tenant ON pending_overpayments (tenant_code);
CREATE INDEX IF NOT EXISTS idx_pending_op_status ON pending_overpayments (status);
CREATE INDEX IF NOT EXISTS idx_pending_op_payment ON pending_overpayments (payment_id);

-- Credit balance application records: amount applied, target, reason, and the
-- approving user for management-controlled credit applications.
CREATE TABLE IF NOT EXISTS credit_allocations (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR(32) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  target VARCHAR(20) NOT NULL,
  reason TEXT NULL,
  approved_by VARCHAR(128) NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_alloc_tenant ON credit_allocations (tenant_code);

-- Exit invoices: generated when a tenant is ready to leave. Remains editable
-- (Draft) until finalized. Lines hold maintenance/repair/cleaning/painting/
-- utility/other deductions plus the deposit refund review.
CREATE TABLE IF NOT EXISTS exit_invoices (
  id SERIAL PRIMARY KEY,
  exit_number VARCHAR(32) NOT NULL UNIQUE,
  tenant_code VARCHAR(32) NOT NULL,
  property_name VARCHAR(128) NULL,
  house_paybill_number VARCHAR(32) NULL REFERENCES houses(paybill_number) ON DELETE SET NULL,
  unit_label VARCHAR(64) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Finalized')),
  lines JSONB NOT NULL DEFAULT '[]',
  deductions_total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_paid DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_refund DECIMAL(10, 2) NOT NULL DEFAULT 0,
  outstanding_balance DECIMAL(10, 2) NOT NULL DEFAULT 0,
  final_settlement DECIMAL(10, 2) NOT NULL DEFAULT 0,
  move_out_date DATE NULL,
  reason TEXT NULL,
  archive_id INTEGER NULL REFERENCES tenancy_archive(id) ON DELETE SET NULL,
  finalized_by VARCHAR(128) NULL,
  finalized_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exit_inv_tenant ON exit_invoices (tenant_code);
CREATE INDEX IF NOT EXISTS idx_exit_inv_house ON exit_invoices (house_paybill_number);
CREATE INDEX IF NOT EXISTS idx_exit_inv_status ON exit_invoices (status);

-- Exit invoice lifetime numbering (shares invoice_counters).
INSERT INTO invoice_counters (prefix, next_number) VALUES ('GEHPM-EXT', 1) ON CONFLICT (prefix) DO NOTHING;

-- =====================================================================
-- PERMANENT INVOICE REGISTER & ARCHIVE MODULE
-- Every invoice generated by the system (rent, maintenance, penalty, exit)
-- is recorded here the moment it is issued and is NEVER deleted. Download and
-- WhatsApp-send events update the delivery status so the original invoice
-- number, contents and history are always preserved for audit, legal
-- reference, landlord reporting and reconciliation.
CREATE TABLE IF NOT EXISTS invoice_register (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NULL,
  invoice_number VARCHAR(64) NOT NULL,
  invoice_type VARCHAR(32) NOT NULL DEFAULT 'other',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by VARCHAR(128) NULL,
  tenant_code VARCHAR(32) NULL,
  tenant_name VARCHAR(128) NULL,
  property_name VARCHAR(128) NULL,
  house_paybill_number VARCHAR(32) NULL,
  unit_label VARCHAR(64) NULL,
  amount DECIMAL(10, 2) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Generated'
    CHECK (status IN ('Generated', 'Downloaded', 'Sent via WhatsApp', 'Downloaded & Sent')),
  downloaded_at TIMESTAMPTZ NULL,
  sent_at TIMESTAMPTZ NULL,
  -- Exit Invoice Register fields (populated for exit invoices only)
  move_out_date DATE NULL,
  deposit_paid DECIMAL(10, 2) NULL,
  deposit_refund DECIMAL(10, 2) NULL,
  deductions_total DECIMAL(10, 2) NULL,
  final_refund DECIMAL(10, 2) NULL,
  approved_by VARCHAR(128) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invreg_type ON invoice_register (invoice_type);
CREATE INDEX IF NOT EXISTS idx_invreg_date ON invoice_register (generated_at);
CREATE INDEX IF NOT EXISTS idx_invreg_tenant ON invoice_register (tenant_code);
CREATE INDEX IF NOT EXISTS idx_invreg_house ON invoice_register (house_paybill_number);
CREATE INDEX IF NOT EXISTS idx_invreg_unit ON invoice_register (unit_label);
CREATE INDEX IF NOT EXISTS idx_invreg_number ON invoice_register (invoice_number);
CREATE INDEX IF NOT EXISTS idx_invreg_status ON invoice_register (status);
CREATE INDEX IF NOT EXISTS idx_invreg_document ON invoice_register (document_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invreg_document ON invoice_register (document_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'exit_invoices' AND column_name = 'finalized_by'
  ) THEN
    ALTER TABLE exit_invoices ADD COLUMN finalized_by VARCHAR(128) NULL;
  END IF;
END $$;

-- =====================================================================
-- MONTHLY FINANCIAL REPORTS
-- Auto-generated at rollover. Each month's report is a permanent snapshot
-- of revenue, maintenance expenses, tenant recovery and outstanding amounts.
-- Once a month is closed/archived its figures never change; corrections are
-- recorded as adjustment entries.
CREATE TABLE IF NOT EXISTS monthly_reports (
  id SERIAL PRIMARY KEY,
  month VARCHAR(7) NOT NULL, -- "2026-08"
  property_name VARCHAR(128) NULL,
  house_paybill_number VARCHAR(32) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Closed', 'Archived')),
  report_data JSONB NOT NULL DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_monthly_report_month_prop
  ON monthly_reports (month, house_paybill_number);
CREATE INDEX IF NOT EXISTS idx_monthly_report_status ON monthly_reports (status);

-- =====================================================================
-- MAINTENANCE CHARGES (linking Work Order issues to tenant recovery)
-- Created when a Work Order is completed. Each row represents one issue
-- from a work order and tracks who is responsible, how much was charged,
-- how much has been recovered, and from which payment.
CREATE TABLE IF NOT EXISTS maintenance_charges (
  id SERIAL PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  wo_number VARCHAR(32) NULL,
  issue_no INTEGER NOT NULL,
  unit_code VARCHAR(32) NULL,
  tenant_code VARCHAR(32) NULL,
  tenant_name VARCHAR(128) NULL,
  problem TEXT NULL,
  repair_description TEXT NULL,
  -- Costs
  material_cost DECIMAL(10, 2) NOT NULL DEFAULT 0,
  labour_cost DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total_cost DECIMAL(10, 2) NOT NULL DEFAULT 0,
  -- Responsibility
  responsible_party VARCHAR(64) NOT NULL DEFAULT 'Pending Assessment',
  -- Recovery tracking
  recovery_status VARCHAR(32) NOT NULL DEFAULT 'Pending Assessment'
    CHECK (recovery_status IN ('Pending Assessment', 'Pending', 'Partially Recovered', 'Paid', 'N/A')),
  amount_charged DECIMAL(10, 2) NOT NULL DEFAULT 0,
  amount_recovered DECIMAL(10, 2) NOT NULL DEFAULT 0,
  -- Traceable links
  penalty_id INTEGER NULL,
  payment_id INTEGER NULL,
  receipt_number VARCHAR(32) NULL,
  transaction_reference VARCHAR(64) NULL,
  -- Month this charge belongs to (based on WO completion date)
  charge_month VARCHAR(7) NULL,
  -- Payment to technician
  technician_paid BOOLEAN NOT NULL DEFAULT FALSE,
  technician_paid_at DATE NULL,
  technician_amount DECIMAL(10, 2) NULL,
  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maint_charge_wo ON maintenance_charges (work_order_id);
CREATE INDEX IF NOT EXISTS idx_maint_charge_tenant ON maintenance_charges (tenant_code);
CREATE INDEX IF NOT EXISTS idx_maint_charge_unit ON maintenance_charges (unit_code);
CREATE INDEX IF NOT EXISTS idx_maint_charge_month ON maintenance_charges (charge_month);
CREATE INDEX IF NOT EXISTS idx_maint_charge_status ON maintenance_charges (recovery_status);

-- =====================================================================
-- PAYMENT BILLING PERIOD (Phase 4 Reconciliation Engine)
-- Distinguishes payment_date (when money was received) from billing_period
-- (which month's obligation the payment satisfies). Advance rent payments
-- from July have payment_date in July but billing_period = 'YYYY-08'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'billing_period'
  ) THEN
    ALTER TABLE payments ADD COLUMN billing_period VARCHAR(7) NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_billing_period ON payments (billing_period);

-- Management Expenses Invoice linkage: tracks which WO management expenses
-- have been included in a Management Expenses Invoice.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'maintenance_charges' AND column_name = 'management_expense_invoice_id'
  ) THEN
    ALTER TABLE maintenance_charges ADD COLUMN management_expense_invoice_id INTEGER NULL;
  END IF;
END $$;

-- =====================================================================
-- DEPOSIT-TO-RENT AUTHORIZATION & RENT LOSS MANAGEMENT
-- Tracks every authorized use of a tenant's security deposit to cover rent,
-- and any rent formally written off as landlord/property loss.
CREATE TABLE IF NOT EXISTS deposit_applications (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR(32) NOT NULL,
  tenant_name VARCHAR(128) NULL,
  unit_code VARCHAR(32) NULL,
  property_name VARCHAR(128) NULL,
  house_paybill_number VARCHAR(32) NULL,
  -- Deposit snapshot at time of application
  original_deposit DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_paid_before DECIMAL(10, 2) NOT NULL DEFAULT 0,
  -- Application details
  amount_applied DECIMAL(10, 2) NOT NULL DEFAULT 0,
  billing_period VARCHAR(7) NOT NULL, -- "2026-08"
  rent_due DECIMAL(10, 2) NOT NULL DEFAULT 0,
  remaining_rent_after DECIMAL(10, 2) NOT NULL DEFAULT 0,
  -- Rent loss (if management writes off the unrecovered portion)
  rent_loss_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  rent_loss_reason TEXT NULL,
  -- Deposit after application
  deposit_remaining DECIMAL(10, 2) NOT NULL DEFAULT 0,
  -- Authorization
  authorized_by VARCHAR(128) NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NULL,
  -- Traceable references
  transaction_reference VARCHAR(64) NULL,
  adjustment_id INTEGER NULL, -- link to payments table if an adjustment record is created
  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Reversed')),
  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_depapp_tenant ON deposit_applications (tenant_code);
CREATE INDEX IF NOT EXISTS idx_depapp_period ON deposit_applications (billing_period);
CREATE INDEX IF NOT EXISTS idx_depapp_status ON deposit_applications (status);

-- =====================================================================
-- EXIT INVOICE: MANAGEMENT DECISION FIELDS
-- Allows management to choose rent treatment (full/pro-rated/waived) and
-- deposit treatment (apply to rent/deductions/both/refund) at exit.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exit_invoices' AND column_name = 'rent_treatment') THEN
    ALTER TABLE exit_invoices ADD COLUMN rent_treatment VARCHAR(32) NULL DEFAULT 'full_month';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exit_invoices' AND column_name = 'rent_charged_amount') THEN
    ALTER TABLE exit_invoices ADD COLUMN rent_charged_amount DECIMAL(10, 2) NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exit_invoices' AND column_name = 'pro_rated_days') THEN
    ALTER TABLE exit_invoices ADD COLUMN pro_rated_days INTEGER NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exit_invoices' AND column_name = 'rent_treatment_reason') THEN
    ALTER TABLE exit_invoices ADD COLUMN rent_treatment_reason TEXT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exit_invoices' AND column_name = 'deposit_treatment') THEN
    ALTER TABLE exit_invoices ADD COLUMN deposit_treatment VARCHAR(32) NULL DEFAULT 'apply_to_deductions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exit_invoices' AND column_name = 'deposit_applied_to_rent') THEN
    ALTER TABLE exit_invoices ADD COLUMN deposit_applied_to_rent DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exit_invoices' AND column_name = 'deposit_applied_to_deductions') THEN
    ALTER TABLE exit_invoices ADD COLUMN deposit_applied_to_deductions DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exit_invoices' AND column_name = 'settlement_decision_reason') THEN
    ALTER TABLE exit_invoices ADD COLUMN settlement_decision_reason TEXT NULL;
  END IF;
END $$;

-- =====================================================================
-- NEW TENANT ENTRY: GUARDIAN + FIRST BILLING FIELDS
-- Guardian/emergency contact and first-cycle billing method are preserved
-- as part of the tenancy record and survive into the archive.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'guardian_name') THEN
    ALTER TABLE tenants ADD COLUMN guardian_name VARCHAR(128) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'guardian_id') THEN
    ALTER TABLE tenants ADD COLUMN guardian_id VARCHAR(64) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'guardian_phone') THEN
    ALTER TABLE tenants ADD COLUMN guardian_phone VARCHAR(20) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'guardian_relationship') THEN
    ALTER TABLE tenants ADD COLUMN guardian_relationship VARCHAR(64) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'standard_monthly_rent') THEN
    ALTER TABLE tenants ADD COLUMN standard_monthly_rent DECIMAL(10, 2) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'first_billing_method') THEN
    ALTER TABLE tenants ADD COLUMN first_billing_method VARCHAR(32) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'first_billing_charge') THEN
    ALTER TABLE tenants ADD COLUMN first_billing_charge DECIMAL(10, 2) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'first_billing_reason') THEN
    ALTER TABLE tenants ADD COLUMN first_billing_reason TEXT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'first_billing_days') THEN
    ALTER TABLE tenants ADD COLUMN first_billing_days INTEGER NULL;
  END IF;
END $$;

-- =====================================================================
-- MANAGEMENT EXPENSE PAYMENTS (Phase 3: Partial reimbursement tracking)
-- Records individual payments made against a management expense invoice.
-- For staff reimbursements, tracks partial payments until fully reimbursed.
-- =====================================================================
CREATE TABLE IF NOT EXISTS management_expense_payments (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES maintenance_invoices(id) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method VARCHAR(64) NULL,
  reference VARCHAR(128) NULL,
  notes TEXT NULL,
  recorded_by VARCHAR(128) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mgmt_exp_pay_invoice ON management_expense_payments (invoice_id);

-- =====================================================================
-- SALARY RECORDS (Phase 4: Salary management)
-- Tracks monthly salary obligations per employee with balance carry-forward.
-- =====================================================================
CREATE TABLE IF NOT EXISTS salary_records (
  id SERIAL PRIMARY KEY,
  employee_name VARCHAR(128) NOT NULL,
  salary_month VARCHAR(7) NOT NULL,
  expected_salary DECIMAL(10, 2) NOT NULL DEFAULT 0,
  previous_balance DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total_paid DECIMAL(10, 2) NOT NULL DEFAULT 0,
  outstanding DECIMAL(10, 2) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Partially Paid', 'Fully Paid')),
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_name, salary_month)
);

CREATE INDEX IF NOT EXISTS idx_salary_rec_month ON salary_records (salary_month);
CREATE INDEX IF NOT EXISTS idx_salary_rec_employee ON salary_records (employee_name);

-- =====================================================================
-- SALARY PAYMENTS (Phase 4: Individual salary payments)
-- Records each payment made against a salary record.
-- =====================================================================
CREATE TABLE IF NOT EXISTS salary_payments (
  id SERIAL PRIMARY KEY,
  salary_record_id INTEGER NOT NULL REFERENCES salary_records(id) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method VARCHAR(64) NULL,
  reference VARCHAR(128) NULL,
  notes TEXT NULL,
  recorded_by VARCHAR(128) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_salary_pay_record ON salary_payments (salary_record_id);

-- =====================================================================
-- STAFF ADVANCES (Phase 6)
-- Tracks advances given to employees for recovery from future salary.
-- =====================================================================
CREATE TABLE IF NOT EXISTS staff_advances (
  id SERIAL PRIMARY KEY,
  employee_name VARCHAR(128) NOT NULL,
  date_advanced DATE NOT NULL DEFAULT CURRENT_DATE,
  amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  reason TEXT NULL,
  property_name VARCHAR(128) NULL,
  unit_code VARCHAR(32) NULL,
  recovery_method VARCHAR(64) NULL DEFAULT 'salary_deduction',
  expected_recovery_month VARCHAR(7) NULL,
  amount_recovered DECIMAL(10, 2) NOT NULL DEFAULT 0,
  outstanding DECIMAL(10, 2) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Partially Recovered', 'Fully Recovered', 'Written Off')),
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_adv_employee ON staff_advances (employee_name);
CREATE INDEX IF NOT EXISTS idx_staff_adv_status ON staff_advances (status);

-- =====================================================================
-- STAFF ADVANCE PAYMENTS (Phase 6)
-- Records each recovery payment against a staff advance.
-- =====================================================================
CREATE TABLE IF NOT EXISTS staff_advance_payments (
  id SERIAL PRIMARY KEY,
  staff_advance_id INTEGER NOT NULL REFERENCES staff_advances(id) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method VARCHAR(64) NULL,
  reference VARCHAR(128) NULL,
  notes TEXT NULL,
  recorded_by VARCHAR(128) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_adv_pay_advance ON staff_advance_payments (staff_advance_id);

-- =====================================================================
-- EMPLOYEE RENT (Phase 6)
-- Tracks rent obligations for employees living in managed properties.
-- =====================================================================
CREATE TABLE IF NOT EXISTS employee_rent (
  id SERIAL PRIMARY KEY,
  employee_name VARCHAR(128) NOT NULL,
  property_name VARCHAR(128) NOT NULL,
  unit_code VARCHAR(32) NOT NULL,
  monthly_rent DECIMAL(10, 2) NOT NULL DEFAULT 0,
  rent_due_day INTEGER NOT NULL DEFAULT 5,
  rent_period VARCHAR(7) NOT NULL,
  previous_balance DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total_paid DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total_deducted DECIMAL(10, 2) NOT NULL DEFAULT 0,
  outstanding DECIMAL(10, 2) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Partially Paid', 'Fully Paid')),
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_name, property_name, unit_code, rent_period)
);

CREATE INDEX IF NOT EXISTS idx_emp_rent_employee ON employee_rent (employee_name);
CREATE INDEX IF NOT EXISTS idx_emp_rent_period ON employee_rent (rent_period);
CREATE INDEX IF NOT EXISTS idx_emp_rent_property ON employee_rent (property_name);

-- =====================================================================
-- EMPLOYEE RENT PAYMENTS (Phase 6)
-- Records each payment made against an employee rent obligation.
-- =====================================================================
CREATE TABLE IF NOT EXISTS employee_rent_payments (
  id SERIAL PRIMARY KEY,
  employee_rent_id INTEGER NOT NULL REFERENCES employee_rent(id) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method VARCHAR(64) NULL,
  reference VARCHAR(128) NULL,
  notes TEXT NULL,
  recorded_by VARCHAR(128) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_emp_rent_pay_rent ON employee_rent_payments (employee_rent_id);

-- =====================================================================
-- SALARY DEDUCTIONS (Phase 6)
-- Tracks approved deductions from employee salary.
-- =====================================================================
CREATE TABLE IF NOT EXISTS salary_deductions (
  id SERIAL PRIMARY KEY,
  employee_name VARCHAR(128) NOT NULL,
  salary_month VARCHAR(7) NOT NULL,
  deduction_type VARCHAR(64) NOT NULL
    CHECK (deduction_type IN ('staff_advance_recovery', 'employee_rent', 'other')),
  description TEXT NULL,
  amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  amount_deducted DECIMAL(10, 2) NOT NULL DEFAULT 0,
  outstanding DECIMAL(10, 2) NOT NULL DEFAULT 0,
  related_id INTEGER NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Partially Deducted', 'Fully Deducted')),
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sal_ded_employee ON salary_deductions (employee_name);
CREATE INDEX IF NOT EXISTS idx_sal_ded_month ON salary_deductions (salary_month);

-- ============================================================
-- DEPOSIT REFUNDS
-- Tracks refundable deposits after tenant exit, linked to Exit Invoices
-- ============================================================
CREATE TABLE IF NOT EXISTS deposit_refunds (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR(64) NOT NULL,
  exit_invoice_id INTEGER UNIQUE NOT NULL,
  archive_id INTEGER NULL,

  deposit_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_paid DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deductions_total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_applied_to_rent DECIMAL(10, 2) NOT NULL DEFAULT 0,
  deposit_applied_to_deductions DECIMAL(10, 2) NOT NULL DEFAULT 0,
  refundable_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,

  amount_refunded DECIMAL(10, 2) NOT NULL DEFAULT 0,
  remaining_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,

  exit_date DATE NULL,
  refund_due_date DATE NULL,
  refund_date DATE NULL,
  refund_time TIME NULL,

  payment_method VARCHAR(32) NULL,
  transaction_reference VARCHAR(128) NULL,
  remarks TEXT NULL,

  refund_status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (refund_status IN ('pending', 'due_soon', 'due_today', 'overdue', 'refunded', 'partially_refunded', 'no_refund_due')),

  created_by VARCHAR(64) NULL,
  refunded_by VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dep_ref_tenant ON deposit_refunds (tenant_code);
CREATE INDEX IF NOT EXISTS idx_dep_ref_exit_invoice ON deposit_refunds (exit_invoice_id);
CREATE INDEX IF NOT EXISTS idx_dep_ref_status ON deposit_refunds (refund_status);
CREATE INDEX IF NOT EXISTS idx_dep_ref_due_date ON deposit_refunds (refund_due_date);

-- Payment mode details (Invoice 5)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'payment_mode'
  ) THEN
    ALTER TABLE payments ADD COLUMN payment_mode VARCHAR(20) NULL;
    ALTER TABLE payments ADD COLUMN sender_account VARCHAR(128) NULL;
    ALTER TABLE payments ADD COLUMN receiver_account VARCHAR(128) NULL;
    ALTER TABLE payments ADD COLUMN cheque_number VARCHAR(64) NULL;
    ALTER TABLE payments ADD COLUMN payment_datetime TIMESTAMPTZ NULL;
  END IF;
END $$;

-- Maintenance invoices: add paid_total column and expand status CHECK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'maintenance_invoices' AND column_name = 'paid_total'
  ) THEN
    ALTER TABLE maintenance_invoices ADD COLUMN paid_total DECIMAL(10, 2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Drop old CHECK constraint and add expanded one (handles status values from all categories)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname LIKE '%maintenance_invoices%status%'
      AND conrelid = 'maintenance_invoices'::regclass
  ) THEN
    ALTER TABLE maintenance_invoices DROP CONSTRAINT IF EXISTS maintenance_invoices_status_check;
  END IF;
END $$;

ALTER TABLE maintenance_invoices
  ADD CONSTRAINT maintenance_invoices_status_check
  CHECK (status IN ('Pending', 'Approved', 'Paid', 'Partially Paid', 'Assigned', 'In Progress', 'Completed', 'Pending Reimbursement', 'Partially Reimbursed', 'Fully Reimbursed'));
