'use strict';

const DEFAULT_TEMPLATES = {
  PAYMENT_RECEIVED:
    'Dear {{TENANT_NAME}}, your rent payment of KES {{AMOUNT}} for the month of {{MONTH}} {{YEAR}} for House No. {{HOUSE_NO}}, {{PROPERTY_NAME}} has been successfully received by GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS.\n\nRent Due for {{MONTH}} {{YEAR}} was KES {{TOTAL_DUE}} ({{DUE_BREAKDOWN}}). Your payment has been allocated as follows: {{ALLOCATION}}.{{REMAINING_TEXT}}\n\nTransaction Ref: {{REFERENCE}}. Next rent due: {{NEXT_DUE}}. Thank you.',

  RENT_REMINDER:
    'Dear {{TENANT_NAME}}, this is a reminder that your rent of KES {{AMOUNT}} for {{MONTH}} {{YEAR}} is due on {{DUE_DATE}}.\n\nHouse No. {{HOUSE_NO}}, {{PROPERTY_NAME}}\n\nPlease ensure timely payment to avoid penalties.\n\nGUTENBERG ELITE HOME & PROPERTY MANAGEMENTS\nFind a Home. Leave the Management to Us.',

  RENT_INVOICE:
    'Dear {{TENANT_NAME}},\n\nYour rent invoice has been generated.\n\nProperty: {{PROPERTY_NAME}}\nUnit: {{HOUSE_NO}}\nAmount: KES {{AMOUNT}}\nDue date: {{DUE_DATE}}\n\nPlease find the invoice attached.\n\nGUTENBERG ELITE HOME & PROPERTY MANAGEMENTS',

  MAINTENANCE_RECEIVED:
    'Hi {{TENANT_NAME}},\n\nYour maintenance request #{{REQUEST_ID}} has been received.\n\nIssue: {{DESCRIPTION}}\nHouse No. {{HOUSE_NO}}, {{PROPERTY_NAME}}\n\nOur team will review it shortly.\n\nGUTENBERG ELITE HOME & PROPERTY MANAGEMENTS',

  MAINTENANCE_UPDATED:
    'Hi {{TENANT_NAME}},\n\nYour maintenance request #{{REQUEST_ID}} has been updated.\n\nStatus: {{STATUS}}{{TECHNICIAN_TEXT}}\n\nGUTENBERG ELITE HOME & PROPERTY MANAGEMENTS',

  WELCOME_TENANT:
    'Dear {{TENANT_NAME}},\n\nWELCOME to GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS. Your tenancy at House No. {{HOUSE_NO}}, {{PROPERTY_NAME}} is now active.\n\nTOTAL DUE UPON OCCUPANCY: KES {{TOTAL_DUE}}\n({{DUE_BREAKDOWN}})\n\nYour payment of KES {{AMOUNT}} for {{MONTH}} {{YEAR}} has been successfully received. It has been allocated as follows: {{ALLOCATION}}.{{REMAINING_TEXT}}\n\nTransaction Ref: {{REFERENCE}}. Next rent due: {{NEXT_DUE}}.\n\nWelcome {{FIRST_NAME}}! We are delighted to have you. If you require any assistance, kindly contact our office on 0725 934 615 / 0702 705 321.\n\nGUTENBERG ELITE HOME & PROPERTY MANAGEMENTS\nFind a Home. Leave the Management to Us.',

  GENERAL_ANNOUNCEMENT:
    '📢 Announcement\n\n{{MESSAGE}}\n\n— GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS\nFind a Home. Leave the Management to Us.',
};

let _templates = { ...DEFAULT_TEMPLATES };

/**
 * Replace {{variable}} placeholders with values from the variables object.
 * Also handles {{#if variable}}...{{/if}} blocks.
 */
function renderTemplate(templateKey, variables = {}) {
  const tmpl = _templates[templateKey];
  if (!tmpl) throw new Error(`Template "${templateKey}" not found`);

  let result = tmpl;

  // Process {{#if variable}}...{{/if}} blocks
  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, block) => {
      const val = variables[key];
      if (val !== undefined && val !== null && val !== '' && val !== false) {
        return block;
      }
      return '';
    }
  );

  // Replace remaining {{variable}} placeholders
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = variables[key];
    return val !== undefined && val !== null ? String(val) : '';
  });

  return result;
}

/**
 * Get the raw template string for a given key.
 */
function getTemplate(templateKey) {
  const tmpl = _templates[templateKey];
  if (!tmpl) throw new Error(`Template "${templateKey}" not found`);
  return tmpl;
}

/**
 * List all available template keys.
 */
function listTemplates() {
  return Object.keys(_templates);
}

/**
 * Render a template with sample variables for preview purposes.
 */
function previewTemplate(templateKey, sampleVars = {}) {
  return renderTemplate(templateKey, sampleVars);
}

module.exports = {
  renderTemplate,
  getTemplate,
  listTemplates,
  previewTemplate,
};
