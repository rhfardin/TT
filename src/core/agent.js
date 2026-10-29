// What the AI says and can do: prompt variables, tools, outcomes, follow-up message.

// Values for every {{placeholder}} in prompts/sales-agent.md. ElevenLabs gets them as
// dynamic variables; the OpenAI bridge fills them in itself.
export function promptVariables(lead, seller) {
  return {
    lead_id: String(lead.id),
    business_name: lead.business_name || '',
    contact_name: lead.contact_name || '',
    contact_name_or_owner: lead.contact_name || 'the owner or whoever handles the website',
    category: lead.category || 'local',
    city_phrase: lead.city ? ` in ${lead.city}` : '',
    website: lead.website || 'not known',
    demo_link: lead.demo_link || '',
    lead_email: lead.email || '',
    business_notes: (lead.notes || 'Nothing beyond the name and website.').slice(0, 1500),
    agent_name: seller.agentName,
    your_name: seller.yourName || 'our team',
    your_company: seller.company || 'our studio',
    offer_phrase: seller.price ? ` (${seller.price})` : '',
    price_answer: seller.price
      ? `It's ${seller.price}. Say it simply, then point out the preview is free to look at first.`
      : `Say ${seller.yourName || 'the team'} will go over pricing personally, it depends on what they need, and the preview is free.`,
  };
}

export function renderPrompt(template, lead, seller) {
  const vars = promptVariables(lead, seller);
  const extra = lead.email ? `\n\n# Email on file\nThe email we have on file is ${lead.email}. Confirm it before sending.` : '';
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? '') + extra;
}

export function firstGreeting(lead, seller) {
  const who = lead.contact_name ? `Could I speak with ${lead.contact_name}?` : 'Am I speaking with the owner?';
  return `Hi, this is ${seller.agentName}, an AI assistant calling for ${seller.yourName || 'the team'} at ` +
    `${seller.company || 'our studio'} about the ${lead.business_name} website. ${who}`;
}

export const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'send_demo_link',
    description: 'Send the redesigned website preview link (plus booking/payment links) to the business right now.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address the person confirmed. Leave empty to use the one on file.' },
        contact_name: { type: 'string', description: 'Name of the person to address the message to.' },
        channel: { type: 'string', enum: ['email', 'sms', 'both'], description: 'How to send it. sms texts the number we called.' },
      },
      required: ['channel'],
    },
  },
  {
    type: 'function',
    name: 'mark_do_not_call',
    description: 'Use when the person asks not to be called again or to be removed from the list.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } } },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up. Use after saying goodbye, or immediately on voicemail, phone menus or wrong numbers.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', enum: ['finished', 'voicemail', 'wrong_number', 'not_interested', 'other'] } },
    },
  },
];

// Maps the call outcome to a lead status.
export const OUTCOME_STATUS = {
  sold: 'won',
  won: 'won',
  interested: 'interested',
  meeting_booked: 'interested',
  link_sent: 'interested',
  callback: 'callback',
  gatekeeper: 'callback',
  not_interested: 'not_interested',
  wrong_number: 'not_interested',
  do_not_call: 'dnc',
  voicemail: 'voicemail',
  no_answer: 'no_answer',
};
export const OUTCOMES = Object.keys(OUTCOME_STATUS);

export function followUpMessage(lead, name, seller) {
  const lines = [
    name ? `Hi ${name},` : 'Hi,',
    '',
    `Thanks for taking the call just now. Here is the new website we put together for ${lead.business_name}:`,
    lead.demo_link || lead.website || '',
    '',
  ];
  if (seller.bookingLink) lines.push(`If you'd like to go over it together, grab a time here: ${seller.bookingLink}`, '');
  if (seller.paymentLink) lines.push(`When you're ready to go live, you can get started here: ${seller.paymentLink}`, '');
  lines.push('Just reply to this email with any questions or changes you want.', '', seller.yourName || '', seller.company || '');
  return lines.join('\n').trim();
}
