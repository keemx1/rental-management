'use strict';

/**
 * Documents Hub letter templates (additive).
 * Each template declares its fields; the UI builds the form from `fields`,
 * resolves placeholders (form values > tenant record > house record >
 * computed defaults) and renders the official letterhead.
 *
 * Field: { name, label, type: text|textarea|date|month|number|select,
 *          required?, options?, default?, placeholder? }
 * Special defaults: 'today' (formatted date), 'this_month' (YYYY-MM).
 */

const TEMPLATES = [
  {
    key: 'change_of_management',
    label: 'Change of Management Letter',
    description: 'Notify tenants of a change in property management.',
    recipient: 'tenant',
    subject: 'CHANGE OF PROPERTY MANAGEMENT — {{property_name}}',
    fields: [
      { name: 'old_manager', label: 'Outgoing Manager/Agent', type: 'text', required: true },
      { name: 'effective_date', label: 'Effective Date', type: 'date', required: true, default: 'today' },
      { name: 'new_contact', label: 'New Management Contact', type: 'text', placeholder: 'e.g. 0725 934 615' },
    ],
    body: `Dear {{tenant_name}},

RE: CHANGE OF MANAGEMENT — {{property_name}}, HOUSE {{unit_label}}

This letter serves to notify you that with effect from {{effective_date}}, the management of {{property_name}} has changed hands from {{old_manager}} to Gutenberg Elite Home & Property Managements, acting on behalf of the landlord.

All rent payments, queries, maintenance requests and official communication regarding your tenancy should from the effective date be directed to Gutenberg Elite Home & Property Managements{{new_contact_block}}.

Your tenancy terms, rent amount and payment dates remain unchanged. Any balances or deposits held transfer automatically and in full under the new management.

We look forward to serving you.`,
  },
  {
    key: 'caretaker_change',
    label: 'Caretaker/Agent Change Letter',
    description: 'Announce a change of caretaker or site agent.',
    recipient: 'tenant',
    subject: 'CHANGE OF CARETAKER — {{property_name}}',
    fields: [
      { name: 'old_caretaker', label: 'Outgoing Caretaker', type: 'text', required: true },
      { name: 'new_caretaker', label: 'Incoming Caretaker', type: 'text', required: true },
      { name: 'new_caretaker_phone', label: 'Incoming Caretaker Phone', type: 'text' },
      { name: 'effective_date', label: 'Effective Date', type: 'date', required: true, default: 'today' },
    ],
    body: `Dear {{tenant_name}},

RE: CHANGE OF CARETAKER — {{property_name}}, HOUSE {{unit_label}}

Please be informed that with effect from {{effective_date}}, {{old_caretaker}} ceases to be the caretaker of {{property_name}} and {{new_caretaker}} takes over the role{{new_caretaker_phone_block}}.

Kindly accord the incoming caretaker your full cooperation. All outstanding estate matters previously reported remain valid and will be followed up without the need to re-report them.

Thank you for your continued cooperation.`,
  },
  {
    key: 'tenant_notice',
    label: 'Tenant Notice',
    description: 'General formal notice to a tenant.',
    recipient: 'tenant',
    subject: '{{notice_subject}}',
    fields: [
      { name: 'notice_subject', label: 'Notice Subject', type: 'text', required: true },
      { name: 'notice_body', label: 'Notice Details', type: 'textarea', required: true },
      { name: 'action_required', label: 'Action Required (optional)', type: 'textarea' },
      { name: 'deadline_date', label: 'Deadline Date (optional)', type: 'date' },
    ],
    body: `Dear {{tenant_name}},

RE: {{notice_subject}} — {{property_name}}, HOUSE {{unit_label}}

{{notice_body}}{{action_required_block}}{{deadline_block}}

Please treat this matter with the urgency it deserves.`,
  },
  {
    key: 'auctioneer_instruction',
    label: 'Auctioneer Instruction Letter',
    description: 'Instruct an auctioneer to recover arrears/distress.',
    recipient: 'custom',
    subject: 'INSTRUCTIONS TO PROCEED — ARREARS RECOVERY',
    fields: [
      { name: 'recipient_name', label: 'Auctioneer Firm', type: 'text', required: true },
      { name: 'recipient_address', label: 'Auctioneer Address', type: 'textarea' },
      { name: 'arrears_amount', label: 'Arrears Amount (KES)', type: 'number', required: true },
      { name: 'instruction_details', label: 'Instructions', type: 'textarea', required: true },
    ],
    body: `Dear Sir/Madam,

RE: INSTRUCTIONS TO PROCEED AGAINST {{tenant_name}}, HOUSE {{unit_label}}, {{property_name}}

We, Gutenberg Elite Home & Property Managements, acting as agents for the landlord, hereby instruct you to proceed with recovery of outstanding arrears amounting to KES {{arrears_amount}} owed by the above-named tenant.

{{instruction_details}}

Kindly acknowledge receipt of these instructions and keep us updated on progress. Your fees and lawful charges in this matter are noted.`,
  },
  {
    key: 'vacate_notice',
    label: 'Vacate Notice',
    description: 'Notice to vacate issued to a tenant.',
    recipient: 'tenant',
    subject: 'NOTICE TO VACATE — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'notice_days', label: 'Notice Period (days)', type: 'number', required: true, default: '30' },
      { name: 'vacate_date', label: 'Vacate By Date', type: 'date', required: true },
      { name: 'vacate_reason', label: 'Reason', type: 'textarea', required: true },
    ],
    body: `Dear {{tenant_name}},

RE: {{notice_days}}-DAY NOTICE TO VACATE — {{property_name}}, HOUSE {{unit_label}}

Take notice that you are hereby required to vacate and hand over vacant possession of House {{unit_label}}, {{property_name}}, on or before {{vacate_date}}, being {{notice_days}} days from the date hereof.

Reason: {{vacate_reason}}

All outstanding balances including rent arrears, water, garbage and any other charges must be cleared on or before handover. An exit inspection shall be conducted and your deposit refund computed in accordance with your tenancy terms.

Please govern yourself accordingly.`,
  },
  {
    key: 'tenancy_agreement',
    label: 'Tenancy Agreement',
    description: 'Formal tenancy agreement for signing.',
    recipient: 'tenant',
    subject: 'TENANCY AGREEMENT — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'start_date', label: 'Tenancy Start Date', type: 'date', required: true },
      { name: 'duration_months', label: 'Duration — leave as 1 or blank for Monthly / Month-to-Month', type: 'number', required: false, default: '' },
      { name: 'agreement_terms', label: 'Terms & Conditions', type: 'textarea', required: true,
        default: '1. Rent is payable in advance on or before the 5th day of each month.\n2. A security deposit equivalent to the stated deposit amount is held against damages and unpaid bills.\n3. The tenant shall keep the premises clean and in good condition, fair wear and tear excepted.\n4. Either party may terminate by giving one month written notice.\n5. Subletting without written landlord consent is prohibited.' },
    ],
    body: `TENANCY AGREEMENT

This agreement is made and entered on ……….. of ……………... year …………………………………….

BETWEEN

Name: {{tenant_name}} ID NO: {{tenant_id}} TEL: {{tenant_phone}}

Next of kin: {{next_of_kin_name}} Relationship: {{next_of_kin_relationship}}

ID NO: ……………………………………. TEL: {{next_of_kin_phone}}

OCCUPATION/PLACE OF WORK: …….…………………………………………………………………………………………………………………

AND

The duly appointed property managing Agent; Gutenberg Elite Home & Property Managements (hereinafter referred to as Agent).

The Landlord offers to let residential House No. {{unit_number}} of the above apartments and the tenant(s) hereby accept renting the same under the following conditions:

1). MONTHLY RENT

Monthly rent agreed in words:

{{monthly_rent}}

2). RENT PAYMENT

Rent should be deposited in:

{{payment_mode}}

Cash payment to the caretaker or agent or office is NOT ACCEPTED and will NOT be ACKNOWLEDGED.

3). RENT DEPOSIT

By execution of this Agreement on or before the date of commencing of this Tenancy, the Tenant is to pay one month's rent deposit of:

{{deposit}}

3B). TENANCY AGREEMENT FEE

The Tenant shall pay a one-time, non-refundable Tenancy Agreement Fee of KES 1,500 for the preparation and processing of this Agreement by the Property Manager and Legal Counsel.

Payment to be made directly to Management.

4). LATE RENT PAYMENT

Rent payment after the 5th day of every month will result in a penalty of 10% of the month's rent, and electricity will be disconnected on the 6th and the house locked on the 15th.

For any assistance on late payment, visit our offices along Thika Road, JUJA GATE C (MARIANA HSE, 1ST FLOOR, ROOM MA9) or contact the Agent on 0725934615 / 0702705321.

5). RENT DEPOSIT REFUND

The deposit will be refunded by the 30th day of the subsequent month.

The refundable deposit will be net of deductions for painting and any repairs done to restore the house to its original condition.

If the one-month rent deposit is not enough for repairing and repainting the vacated premises, the Agent shall demand the surplus amount thereof from the Tenant.

6). GOOD NEIGHBOURLINESS

Tenants agree and are expected to exercise good neighbourliness, characterized by cleanliness, temperance and virtuous behaviour throughout their stay.

7). RENT ARREARS / FAILURE TO COMPLY

Tenants who fail to comply with the terms of this Agreement or fail to pay rent for two (2) consecutive months will be required to move out upon receiving notice of not more than fourteen (14) days from the Agent.

8). ALTERATIONS

No substantial alterations, additions or improvements shall be made by the Tenant without the express permission of the Landlord or Agent.

9). NOISE AND DISTURBANCE

All tenants are required to minimise and control all noise coming from their units from 10:00 PM onwards and to respect the peace and comfort of other residents.

Tenants must avoid loud music, shouting, gatherings, television or any other activity that may disturb neighbouring residents, particularly during the night.

A tenant found causing excessive noise or disturbance will first receive a warning. Continued disturbance after the warning may result in the tenant's electricity being switched off until the following morning.

Continued or repeated offenders will be issued with a notice to vacate the premises.

All residents are entitled to peace of mind and a quiet environment where they can relax after a busy day, sleep, study, work and enjoy their homes without unnecessary disturbance.

All tenants are therefore expected to be considerate and respectful of the comfort and wellbeing of fellow residents at all times.

10). SECURITY

SECURITY STARTS WITH YOU AND ME.

Every resident has a responsibility to contribute to the security and safety of the apartment.

All tenants and residents are required to follow and observe all security measures put in place at the apartment and to cooperate with management, security personnel, caretakers and fellow residents on all security matters.

Tenants should remain vigilant, secure their doors and belongings, control access to their units, and immediately report any suspicious activity, unfamiliar persons or security concerns to management or the appropriate security personnel.

Security starts with you and me. By working together and following the security measures provided, we can maintain a safe and secure environment for everyone.

11). REPAIRS

Any repairs done to the house before entry of the Tenant will be done by the Landlord.

However, repairs arising during the tenancy and attributable to the Tenant will be borne by the Tenant.

12). TERMINATION OF AGREEMENT

Either party can terminate this Agreement by giving one month's notice.

Failure to do so by the Tenant will lead to forfeiture of the rent deposit by the Tenant.

A Tenant shall be expected to move out by the 30th/31st day of the month within which a notice is issued. Failure to do so will lead to the next month's rent accruing.

13). PETS

No pets are allowed in the compound.

Any Tenant having pets MUST keep them indoors.

14). JUNKED PROPERTY AND HOUSEHOLD ITEMS

The Tenant agrees not to keep junked property, cars or other household items within the compound.

15). RENT REVIEW

The Landlord reserves the right to review rent depending on the prevailing economic situation.

It is agreed that the Landlord will give the Tenant one month's notice of the rent review.

IN WITNESS THEREOF

Signed by Tenant:
……………………………………… Date: ……………………………………

Signed by Agent on behalf of Landlord:
……………………………………… Date: ……………………………………`,
  },
  {
    key: 'waiver',
    label: 'Waiver',
    description: 'Waive a charge, penalty or requirement.',
    recipient: 'tenant',
    subject: 'WAIVER — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'waived_item', label: 'Item Waived', type: 'text', required: true, placeholder: 'e.g. Late payment penalty for October 2026' },
      { name: 'waived_amount', label: 'Amount Waived (KES, optional)', type: 'number' },
      { name: 'waiver_reason', label: 'Reason', type: 'textarea', required: true },
      { name: 'valid_until', label: 'Valid Until (optional)', type: 'date' },
    ],
    body: `Dear {{tenant_name}},

RE: WAIVER — {{waived_item}}, HOUSE {{unit_label}}, {{property_name}}

Following your request and our review, management has approved a waiver of {{waived_item}}{{waived_amount_block}}.

Reason: {{waiver_reason}}

This waiver is a one-off goodwill gesture{{valid_until_block}} and does not alter your tenancy terms or set a precedent for future charges, which remain payable in full and on time.`,
  },
  {
    key: 'verification_letter',
    label: 'Verification Letter',
    description: 'Verify tenancy or payment records.',
    recipient: 'custom',
    subject: 'LETTER OF VERIFICATION — {{tenant_name}}',
    fields: [
      { name: 'recipient_name', label: 'Addressed To', type: 'text', required: true, placeholder: 'e.g. The Branch Manager, ABC Bank' },
      { name: 'recipient_address', label: 'Address', type: 'textarea' },
      { name: 'verification_details', label: 'What Is Verified', type: 'textarea', required: true },
    ],
    body: `Dear Sir/Madam,

RE: VERIFICATION IN RESPECT OF {{tenant_name}}, HOUSE {{unit_label}}, {{property_name}}

At your request, we confirm as follows, based on records held by Gutenberg Elite Home & Property Managements:

{{verification_details}}

Tenant particulars on record: {{tenant_name}}, ID {{national_id_block}}, Tel {{phone_number}}, House {{unit_label}}, {{property_name}}.

This letter is issued for the stated purpose only and creates no further obligation on our part.`,
  },
  {
    key: 'employee_verification',
    label: 'Employee/Agent Verification Letter',
    description: 'Verify employment or agency of staff.',
    recipient: 'custom',
    subject: 'EMPLOYMENT VERIFICATION — {{employee_name}}',
    fields: [
      { name: 'recipient_name', label: 'Addressed To', type: 'text', required: true },
      { name: 'recipient_address', label: 'Address', type: 'textarea' },
      { name: 'employee_name', label: 'Employee/Agent Name', type: 'text', required: true },
      { name: 'employee_role', label: 'Role/Designation', type: 'text', required: true },
      { name: 'employment_details', label: 'Employment Details', type: 'textarea', required: true },
    ],
    body: `Dear Sir/Madam,

RE: VERIFICATION OF EMPLOYMENT — {{employee_name}}

We confirm that {{employee_name}} serves with Gutenberg Elite Home & Property Managements as {{employee_role}}.

{{employment_details}}

Please contact our office for any further clarification.`,
  },
  {
    key: 'proposal',
    label: 'Proposal',
    description: 'Business or service proposal.',
    recipient: 'custom',
    subject: 'PROPOSAL — {{proposal_title}}',
    fields: [
      { name: 'recipient_name', label: 'Addressed To', type: 'text', required: true },
      { name: 'recipient_address', label: 'Address', type: 'textarea' },
      { name: 'proposal_title', label: 'Proposal Title', type: 'text', required: true },
      { name: 'proposal_body', label: 'Proposal Details', type: 'textarea', required: true },
      { name: 'proposal_amount', label: 'Proposed Amount (KES, optional)', type: 'number' },
    ],
    body: `Dear Sir/Madam,

RE: {{proposal_title}}

Gutenberg Elite Home & Property Managements is pleased to submit the following proposal:

{{proposal_body}}{{proposal_amount_block}}

We trust the above meets your requirements and look forward to your favourable consideration.`,
  },
  {
    key: 'recommendation_letter',
    label: 'Recommendation Letter',
    description: 'Recommend a tenant, employee or contractor.',
    recipient: 'custom',
    subject: 'RECOMMENDATION — {{subject_name}}',
    fields: [
      { name: 'recipient_name', label: 'Addressed To', type: 'text', required: true, placeholder: 'e.g. To Whom It May Concern' },
      { name: 'subject_name', label: 'Person Recommended', type: 'text', required: true },
      { name: 'recommendation_body', label: 'Recommendation', type: 'textarea', required: true },
    ],
    body: `Dear Sir/Madam,

RE: RECOMMENDATION IN RESPECT OF {{subject_name}}

We are pleased to recommend {{subject_name}} to you on the strength of our direct dealings:

{{recommendation_body}}

We commend {{subject_name}} to you without reservation for the purpose stated.`,
  },
  {
    key: 'garbage_collection',
    label: 'Garbage Collection Letter',
    description: 'Garbage service arrangement or complaint.',
    recipient: 'custom',
    subject: 'GARBAGE COLLECTION — {{property_name}}',
    fields: [
      { name: 'recipient_name', label: 'Addressed To', type: 'text', required: true, placeholder: 'e.g. The County Environment Office' },
      { name: 'recipient_address', label: 'Address', type: 'textarea' },
      { name: 'collection_details', label: 'Details', type: 'textarea', required: true },
      { name: 'collection_day', label: 'Collection Day (optional)', type: 'text', placeholder: 'e.g. Every Wednesday' },
    ],
    body: `Dear Sir/Madam,

RE: GARBAGE COLLECTION SERVICES — {{property_name}}

Gutenberg Elite Home & Property Managements writes in connection with garbage collection services at {{property_name}}:

{{collection_details}}{{collection_day_block}}

Kindly treat as urgent and confirm action taken.`,
  },
  {
    key: 'warning_letter',
    label: 'Warning Letter',
    description: 'Formal warning to a tenant.',
    recipient: 'tenant',
    subject: 'WARNING LETTER — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'warning_subject', label: 'Subject of Warning', type: 'text', required: true },
      { name: 'warning_details', label: 'Details of Misconduct/Breach', type: 'textarea', required: true },
      { name: 'consequence', label: 'Consequence of Repeat', type: 'textarea', required: true,
        default: 'Should the conduct complained of recur, management shall not hesitate to commence eviction proceedings in accordance with the tenancy agreement and the law.' },
    ],
    body: `Dear {{tenant_name}},

RE: FORMAL WARNING — {{warning_subject}}, HOUSE {{unit_label}}, {{property_name}}

It has come to the attention of management that:

{{warning_details}}

This conduct constitutes a breach of your tenancy obligations. You are hereby formally warned to desist forthwith.

{{consequence}}

Please be guided accordingly and keep a copy of this letter for your records.`,
  },
  {
    key: 'garbage_guard_notice',
    label: 'Garbage / Guard Fee Notice',
    description: 'Demand notice for garbage/guard fees.',
    recipient: 'tenant',
    subject: 'GARBAGE / GUARD FEE NOTICE — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'fee_amount', label: 'Amount Due (KES)', type: 'number', required: true },
      { name: 'fee_period', label: 'Period Covered', type: 'month', required: true, default: 'this_month' },
      { name: 'pay_by_date', label: 'Pay By Date', type: 'date', required: true },
    ],
    body: `Dear {{tenant_name}},

RE: OUTSTANDING GARBAGE / GUARD FEE — HOUSE {{unit_label}}, {{property_name}}

Our records indicate an outstanding garbage/guard fee of KES {{fee_amount}} covering {{fee_period_label}} in respect of the above premises.

Kindly settle the full amount on or before {{pay_by_date}} through the usual payment channels to avoid interruption of estate services and further enforcement action.

Thank you for your prompt attention.`,
  },
  {
    key: 'house_to_let',
    label: 'House to Let',
    description: 'Advertise a vacant house.',
    recipient: 'none',
    subject: 'HOUSE TO LET — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'bedrooms', label: 'Bedrooms/Type', type: 'text', placeholder: 'e.g. 2 Bedroom' },
      { name: 'features', label: 'Features', type: 'textarea', placeholder: 'e.g. Tiled floors, inbuilt wardrobes, ample parking…' },
      { name: 'contact_phone', label: 'Viewing Contact', type: 'text', placeholder: 'e.g. 0725 934 615' },
    ],
    body: `HOUSE TO LET

{{property_name}} — HOUSE {{unit_label}}{{bedrooms_block}}

Monthly Rent: KES {{rent_amount}}
Deposit: KES {{deposit_amount}}

{{features}}

For viewing and enquiries, contact Gutenberg Elite Home & Property Managements{{contact_phone_block}}.

Find a Home. Leave the Management to Us.`,
  },
  {
    key: 'landlord_agreement',
    label: 'Landlord Agreement',
    description: 'Management agreement between landlord and agent.',
    recipient: 'landlord',
    subject: 'PROPERTY MANAGEMENT AGREEMENT — {{property_name}}',
    fields: [
      { name: 'landlord_name', label: 'Landlord Name', type: 'text', required: true },
      { name: 'landlord_id', label: 'Landlord ID No.', type: 'text' },
      { name: 'commission_percent', label: 'Management Commission %', type: 'number', required: true, default: '10' },
      { name: 'start_date', label: 'Agreement Start Date', type: 'date', required: true },
      { name: 'agreement_terms', label: 'Terms', type: 'textarea', required: true,
        default: '1. The Agent shall collect rent, issue receipts and pursue arrears diligently.\n2. The Agent shall remit net collections to the Landlord less the agreed commission and approved expenses.\n3. The Agent shall arrange maintenance with prior landlord approval above KES 5,000 per incident.\n4. Either party may terminate with one month written notice.' },
    ],
    body: `PROPERTY MANAGEMENT AGREEMENT

Between {{landlord_name}}, ID {{landlord_id_block}} (the Landlord), and Gutenberg Elite Home & Property Managements (the Agent), in respect of {{property_name}}.

1. APPOINTMENT: The Landlord appoints the Agent as sole managing agent with effect from {{start_date}}.
2. COMMISSION: {{commission_percent}}% of rent collected.
3. TERMS:
{{agreement_terms}}

SIGNED:

LANDLORD ({{landlord_name}}): ____________________    DATE: ____________

AGENT: ____________________    DATE: ____________`,
  },
  {
    key: 'paybill_closure',
    label: 'Paybill / Account Closure Letter',
    description: 'Request paybill or account closure/change.',
    recipient: 'custom',
    subject: 'CLOSURE OF PAYBILL / ACCOUNT — {{property_name}}',
    fields: [
      { name: 'recipient_name', label: 'Addressed To', type: 'text', required: true, placeholder: 'e.g. Safaricom M-PESA Division' },
      { name: 'recipient_address', label: 'Address', type: 'textarea' },
      { name: 'paybill_number', label: 'Paybill/Account Number', type: 'text', required: true },
      { name: 'closure_reason', label: 'Reason', type: 'textarea', required: true },
      { name: 'effective_date', label: 'Effective Date', type: 'date', required: true },
    ],
    body: `Dear Sir/Madam,

RE: REQUEST FOR CLOSURE OF PAYBILL/ACCOUNT {{paybill_number}} — {{property_name}}

We, Gutenberg Elite Home & Property Managements, write to request closure of the above paybill/account with effect from {{effective_date}}.

Reason: {{closure_reason}}

Kindly confirm closure in writing and advise on settlement of any residual balances to our office.`,
  },
  {
    key: 'rent_increment',
    label: 'Rent Increment Notice',
    description: 'Notify tenant of a rent increase.',
    recipient: 'tenant',
    subject: 'NOTICE OF RENT INCREMENT — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'old_rent', label: 'Current Rent (KES)', type: 'number', required: true },
      { name: 'new_rent', label: 'New Rent (KES)', type: 'number', required: true },
      { name: 'effective_date', label: 'Effective Date', type: 'date', required: true },
      { name: 'increment_reason', label: 'Reason', type: 'textarea', required: true },
    ],
    body: `Dear {{tenant_name}},

RE: RENT INCREMENT — HOUSE {{unit_label}}, {{property_name}}

Take notice that with effect from {{effective_date}}, the monthly rent for the above premises shall be revised from KES {{old_rent}} to KES {{new_rent}}.

Reason: {{increment_reason}}

All other tenancy terms remain unchanged. Rent remains payable in advance on or before the 5th day of each month. Kindly adjust your standing arrangements accordingly.

Thank you for your understanding.`,
  },
  {
    key: 'request_sign_agreement',
    label: 'Request to Fill/Sign Tenancy Agreement',
    description: 'Ask tenant to complete/sign the agreement.',
    recipient: 'tenant',
    subject: 'REQUEST TO SIGN TENANCY AGREEMENT — HOUSE {{unit_label}}',
    fields: [
      { name: 'sign_by_date', label: 'Sign By Date', type: 'date', required: true },
      { name: 'sign_venue', label: 'Venue', type: 'text', placeholder: 'e.g. Our Ruiru office' },
    ],
    body: `Dear {{tenant_name}},

RE: SIGNING OF TENANCY AGREEMENT — HOUSE {{unit_label}}, {{property_name}}

You are kindly requested to complete and sign your tenancy agreement on or before {{sign_by_date}}{{sign_venue_block}}.

Please carry your national ID for verification. Failure to execute the agreement may affect the continued processing of your tenancy.

Thank you for your cooperation.`,
  },
  {
    key: 'water_increment',
    label: 'Water Bill Increment Notice',
    description: 'Notify of water rate/charge increase.',
    recipient: 'tenant',
    subject: 'WATER CHARGE REVISION — {{property_name}}',
    fields: [
      { name: 'old_rate', label: 'Current Rate (KES/unit)', type: 'number', required: true },
      { name: 'new_rate', label: 'New Rate (KES/unit)', type: 'number', required: true },
      { name: 'effective_date', label: 'Effective Date', type: 'date', required: true },
      { name: 'increment_reason', label: 'Reason', type: 'textarea', required: true },
    ],
    body: `Dear {{tenant_name}},

RE: REVISION OF WATER CHARGES — {{property_name}}, HOUSE {{unit_label}}

Please note that with effect from {{effective_date}}, the water rate applicable to the above premises shall be revised from KES {{old_rate}} to KES {{new_rate}} per unit consumed.

Reason: {{increment_reason}}

Your metered consumption will be billed at the new rate from the effective billing month. We encourage economical use of water.

Thank you for your understanding.`,
  },
  {
    key: 'work_schedule',
    label: 'Work Schedule',
    description: 'Planned maintenance work schedule.',
    recipient: 'tenant',
    subject: 'SCHEDULED MAINTENANCE WORKS — {{property_name}}',
    fields: [
      { name: 'work_title', label: 'Works Title', type: 'text', required: true },
      { name: 'start_date', label: 'Start Date', type: 'date', required: true },
      { name: 'end_date', label: 'End Date', type: 'date', required: true },
      { name: 'schedule_items', label: 'Schedule Items (one per line)', type: 'list', required: true },
      { name: 'contact_phone', label: 'Site Contact', type: 'text' },
    ],
    body: `Dear {{tenant_name}},

RE: {{work_title}} — {{property_name}}{{unit_line_block}}

Please note scheduled maintenance works as follows:

Period: {{start_date}} to {{end_date}}

{{schedule_items}}

Access to affected areas will be required during working hours. We regret any inconvenience and appreciate your cooperation{{contact_phone_block}}.`,
  },
  {
    key: 'invoice_letter',
    label: 'Invoice',
    description: 'General demand/pro-forma note saved as a letter (does not touch Invoice Centre numbering or records).',
    recipient: 'custom',
    subject: 'INVOICE — {{invoice_title}}',
    fields: [
      { name: 'recipient_name', label: 'Bill To', type: 'text', required: true },
      { name: 'recipient_address', label: 'Address', type: 'textarea' },
      { name: 'invoice_title', label: 'Invoice Title', type: 'text', required: true, placeholder: 'e.g. Repair works — House B12' },
      { name: 'invoice_items', label: 'Items (one per line)', type: 'list', required: true },
      { name: 'total_amount', label: 'Total Amount (KES)', type: 'number', required: true },
      { name: 'due_date', label: 'Due Date', type: 'date', required: true },
    ],
    body: `Dear {{recipient_name}},

RE: {{invoice_title}}

Please find below our invoice for settlement:

{{invoice_items}}

TOTAL DUE: KES {{total_amount}}
DUE DATE: {{due_date}}

Kindly settle via the usual payment channels and share your confirmation message for prompt updating.

Thank you for your business.`,
  },
  {
    key: 'general_letter',
    label: 'General Letter',
    description: 'Free-form official letter on GEHPM letterhead.',
    recipient: 'custom',
    subject: '{{letter_subject}}',
    fields: [
      { name: 'recipient_name', label: 'Addressed To (optional)', type: 'text' },
      { name: 'recipient_address', label: 'Address (optional)', type: 'textarea' },
      { name: 'letter_subject', label: 'Subject', type: 'text', required: true },
      { name: 'letter_body', label: 'Letter Body', type: 'textarea', required: true },
    ],
    body: `{{letter_salutation}}

RE: {{letter_subject}}

{{letter_body}}`,
  },
  {
    key: 'custom_document',
    label: 'Custom Document',
    description: 'Fully custom title and content on letterhead.',
    recipient: 'none',
    subject: '{{document_title}}',
    fields: [
      { name: 'document_title', label: 'Document Title', type: 'text', required: true },
      { name: 'document_body', label: 'Document Content', type: 'textarea', required: true },
    ],
    body: `{{document_title}}

{{document_body}}`,
  },
  {
    key: 'house_rent_notice',
    label: 'House Rent Notice',
    description: 'Rent-due notice for a house/unit with balance breakdown.',
    recipient: 'tenant',
    subject: 'HOUSE RENT NOTICE — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'billing_month', label: 'Billing Month', type: 'month', required: true, default: 'this_month' },
      { name: 'amount_due', label: 'Amount Due (KES, optional)', type: 'number' },
      { name: 'pay_by_date', label: 'Pay By Date', type: 'date', required: true },
      { name: 'notice_note', label: 'Additional Note (optional)', type: 'textarea' },
    ],
    body: `Dear {{tenant_name}},

RE: HOUSE RENT NOTICE — {{property_name}}, HOUSE {{unit_label}}

This is to notify you that house rent for {{property_name}}, House {{unit_label}} for the month of {{billing_month_label}}{{amount_due_block}} is due.

Rent position on record — Monthly Rent: KES {{rent_amount}} | Arrears: KES {{arrears_amount}} | Outstanding balances are payable together with the current month.

Kindly settle on or before {{pay_by_date}} through the usual payment channels and share your confirmation message for prompt updating.{{notice_note_block}}

Thank you for your cooperation.`,
  },
  {
    key: 'water_billing_notice',
    label: 'Water Billing Notice',
    description: 'Water bill due notice with metered balance.',
    recipient: 'tenant',
    subject: 'WATER BILLING NOTICE — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'billing_month', label: 'Billing Month', type: 'month', required: true, default: 'this_month' },
      { name: 'pay_by_date', label: 'Pay By Date', type: 'date', required: true },
      { name: 'notice_note', label: 'Additional Note (optional)', type: 'textarea' },
    ],
    body: `Dear {{tenant_name}},

RE: WATER BILLING NOTICE — {{property_name}}, HOUSE {{unit_label}}

Our records show an outstanding water balance of KES {{water_balance}} on your account for {{billing_month_label}}.

Kindly settle on or before {{pay_by_date}} to avoid interruption of water services and further enforcement action.{{notice_note_block}}

Thank you for your prompt attention.`,
  },
  {
    key: 'renting_agreement_notice',
    label: 'Renting Agreement Notice',
    description: 'Notify tenant their renting agreement terms are ready.',
    recipient: 'tenant',
    subject: 'YOUR RENTING AGREEMENT — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'start_date', label: 'Agreement Start Date', type: 'date', required: true },
      { name: 'duration_months', label: 'Duration — leave as 1 or blank for Monthly / Month-to-Month', type: 'number', required: false, default: '' },
      { name: 'sign_by_date', label: 'Sign By Date', type: 'date', required: true },
      { name: 'agreement_note', label: 'Additional Note (optional)', type: 'textarea' },
    ],
    body: `Dear {{tenant_name}},

RE: RENTING AGREEMENT — HOUSE {{unit_label}}, {{property_name}}

We are pleased to inform you that your renting agreement for House {{unit_label}}, {{property_name}} is ready.

Agreement summary — Term: {{term_display}} from {{start_date}} | Monthly Rent: KES {{rent_amount}} | Deposit: KES {{deposit_amount}}.

Kindly present yourself to sign the agreement on or before {{sign_by_date}} with your national ID for verification.{{agreement_note_block}}

Thank you for choosing Gutenberg Elite Home & Property Managements.`,
  },
  {
    key: 'rent_demand_notice',
    label: 'Rent Demand / Final Demand Notice',
    description: 'Rent demand with escalating severity (reminder to final demand).',
    recipient: 'tenant',
    subject: '{{demand_severity}} — {{property_name}}, HOUSE {{unit_label}}',
    fields: [
      { name: 'demand_severity', label: 'Severity', type: 'select', required: true,
        options: [
          { value: 'RENT REMINDER', label: 'Friendly Reminder' },
          { value: 'FIRST DEMAND', label: 'First Demand' },
          { value: 'FINAL DEMAND', label: 'FINAL DEMAND' },
        ] },
      { name: 'billing_month', label: 'Billing Month', type: 'month', required: true, default: 'this_month' },
      { name: 'pay_by_date', label: 'Pay By Date', type: 'date', required: true },
      { name: 'demand_note', label: 'Additional Note (optional)', type: 'textarea' },
    ],
    body: `Dear {{tenant_name}},

RE: {{demand_severity}} — RENT DUE, HOUSE {{unit_label}}, {{property_name}}

Our records show the following position on your account for {{billing_month_label}}:

Monthly Rent: KES {{rent_amount}} | Arrears: KES {{arrears_amount}} | Outstanding Balance: KES {{outstanding_balance}}

{{severity_warning}}Kindly settle the outstanding balance on or before {{pay_by_date}} through the usual payment channels and share your confirmation message for prompt updating.{{demand_note_block}}`,
  },
  {
    // Internal: served by its own "Custom Notice" flow in the Documents Hub
    // (subject/body come from the user, recipient details resolve per tenant).
    key: 'custom_notice',
    label: 'Custom Notice (Blank Letterhead)',
    description: 'Custom tenant notice on official letterhead — recipient details auto-filled.',
    internal: true,
    recipient: 'tenant',
    subject: '',
    fields: [],
    body: ``,
  },
];

// GLOBAL DOCUMENT RULE: no Landlord Name/Details slot in any template except
// the Landlord Agreement (the landlord is a required party there). Enforced
// at load so no existing or future template can carry one unnoticed.
for (const t of TEMPLATES) {
  if (t.key === 'landlord_agreement') continue;
  const badField = (t.fields || []).find((f) => /^landlord/i.test(f.name || ''));
  const text = `${t.subject || ''}\n${t.body || ''}`;
  const badVar = (text.match(/\{\{\s*landlord[A-Za-z0-9_]*\s*\}\}/g) || [])[0];
  if (badField || badVar) {
    throw new Error(`[letterTemplates] landlord slot not allowed in template "${t.key}": ${badField ? `field "${badField.name}"` : `placeholder "${badVar}"`} (only landlord_agreement may carry landlord details)`);
  }
}

function getTemplate(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

function listTemplates() {
  return TEMPLATES.filter((t) => !t.internal).map((t) => ({
    key: t.key,
    label: t.label,
    description: t.description,
    recipient: t.recipient,
    fields: t.fields,
    subject: t.subject,
  }));
}

module.exports = { TEMPLATES, getTemplate, listTemplates };
