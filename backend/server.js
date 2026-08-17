const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  assertProductionSecrets,
  buildCorsOptions,
  buildHelmetMiddleware,
  getTrustProxySetting,
  isProduction,
} = require('./config/security');
const { testConnection } = require('./config/database');
const whatsapp = require('./config/whatsapp');
const { startScheduler } = require('./services/scheduler');
const store = require('./storage/store');
const { healthDetailedAuth } = require('./middleware/healthGate');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const tenantRoutes = require('./routes/tenants');
const paymentRoutes = require('./routes/payments');
const dashboardRoutes = require('./routes/dashboard');
const networkRoutes = require('./routes/network');
const houseRoutes = require('./routes/houses');
const templateRoutes = require('./routes/templates');
const invoiceRoutes = require('./routes/invoices');
const broadcastRoutes = require('./routes/broadcasts');
const reportRoutes = require('./routes/reports');
const penaltyRoutes = require('./routes/penalties');
const receiptRoutes = require('./routes/receipts');
const documentRoutes = require('./routes/documents');
const statementRoutes = require('./routes/statements');
const maintenanceInvoiceRoutes = require('./routes/maintenanceInvoices');
const workOrderRoutes = require('./routes/workOrders');
const exitInvoiceRoutes = require('./routes/exitInvoices');
const archiveRoutes = require('./routes/archive');
const pendingOverpaymentRoutes = require('./routes/pendingOverpayments');
const invoiceRegisterRoutes = require('./routes/invoiceRegister');
const monthlyReportRoutes = require('./routes/monthlyReports');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

assertProductionSecrets();

const trustProxy = getTrustProxySetting();
if (trustProxy) app.set('trust proxy', trustProxy);

app.use(buildHelmetMiddleware());
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/network', networkRoutes);
app.use('/api/houses', houseRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/broadcasts', broadcastRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/penalties', penaltyRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/statements', statementRoutes);
app.use('/api/maintenance-invoices', maintenanceInvoiceRoutes);
app.use('/api/salary', require('./routes/salary'));
app.use('/api/staff-advances', require('./routes/staffAdvances'));
app.use('/api/employee-rent', require('./routes/employeeRent'));
app.use('/api/salary-deductions', require('./routes/salaryDeductions'));
app.use('/api/management-expenses-report', require('./routes/managementExpensesReport'));
app.use('/api/work-orders', workOrderRoutes);
app.use('/api/exit-invoices', exitInvoiceRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/pending-overpayments', pendingOverpaymentRoutes);
app.use('/api/invoice-register', invoiceRegisterRoutes);
app.use('/api/monthly-reports', monthlyReportRoutes);
app.use('/api/deposit-refunds', require('./routes/depositRefunds'));

app.get('/api/health', healthDetailedAuth, (req, res) => {
  const payload = { ok: true, timestamp: new Date().toISOString() };
  if (req.healthDetailed) {
    payload.whatsapp = whatsapp.getGatewayState();
    payload.storage = process.env.DATABASE_URL ? 'supabase' : 'json';
  }
  res.json(payload);
});

app.use('/img', express.static(path.join(__dirname, '../img')));

const frontendPath = path.join(__dirname, '../frontend');
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use(express.static(frontendPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendPath, 'index.html'));
});

async function bootstrap() {
  await testConnection();
  whatsapp.initializeWhatsApp().catch((err) => {
    console.error('[WhatsApp Cloud API]', err?.message || err);
  });

  startScheduler();

  function tryListen(port) {
    const srv = app.listen(port, HOST);
    srv.on('listening', () => {
      console.log(`[Server] Rental Messaging (${isProduction() ? 'production' : 'dev'}) http://${HOST}:${port}`);
    });
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[Server] Port ${port} in use, trying ${port + 1}...`);
        tryListen(port + 1);
      } else {
        throw err;
      }
    });
  }
  tryListen(PORT);

  async function gracefulShutdown(signal) {
    console.log(`\n[Server] ${signal} received — shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000);
  }
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

bootstrap();
