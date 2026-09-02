'use strict';

const DEFAULT_TEMPLATES = {
  PAYMENT_RECEIVED:
    'Hello {{tenant_name}} 👋\n\nWe have received your rent payment.\n\nProperty: {{property_name}}\nUnit: {{unit_number}}\nAmount: KES {{amount}}\nReference: {{reference}}\nRemaining balance: KES {{balance}}\n\nThank you.',

  RENT_REMINDER:
    'Hello {{tenant_name}} 👋\n\nThis is a reminder that your rent of KES {{amount}} is due on {{due_date}}.\n\nProperty: {{property_name}}\nUnit: {{unit_number}}\n\nPlease ensure timely payment to avoid penalties.',

  RENT_INVOICE:
    'Hello {{tenant_name}},\n\nYour rent invoice has been generated.\n\nProperty: {{property_name}}\nUnit: {{unit_number}}\nAmount: KES {{amount}}\nDue date: {{due_date}}\n\nPlease find the invoice attached.',

  MAINTENANCE_RECEIVED:
    'Hi {{tenant_name}} 👋\n\nYour maintenance request #{{request_id}} has been received.\n\nIssue: {{description}}\n\nOur team will review it shortly.',

  MAINTENANCE_UPDATED:
    'Hi {{tenant_name}},\n\nYour maintenance request #{{request_id}} has been updated.\n\nStatus: {{status}}\n\n{{#if technician}}Assigned to: {{technician}}{{/if}}',

  WELCOME_TENANT:
    'Hello {{tenant_name}} 👋\n\nWelcome to {{property_name}}!\n\nUnit: {{unit_number}}\nMonthly Rent: KES {{rent_amount}}\nMove-in Date: {{move_in_date}}\n\nWe\'re delighted to have you. For any assistance, contact us at 0725 934 615.\n\nGUTENBERG ELITE HOME & PROPERTY MANAGEMENTS',

  GENERAL_ANNOUNCEMENT:
    '📢 Announcement\n\n{{message}}\n\n— GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS',
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
