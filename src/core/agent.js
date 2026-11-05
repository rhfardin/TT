// What the AI says and can do: prompt variables, tools, outcomes, follow-up message.

const KNOWLEDGE_SECTIONS = [
  ['about', 'About you and your studio'],
  ['included', "What's included in the website"],
  ['pricing', 'Pricing and payment'],
  ['timeline', 'How fast it goes live'],
  ['process', 'What happens after they say yes'],
  ['guarantee', 'Changes, ownership and guarantees'],
  ['proof', 'Past work and results (all true)'],
  ['faq', 'Other questions owners ask, with answers'],
  ['close', 'What to aim for at the end of the call'],
];

// The owner's questionnaire answers, as a prompt section.
export function knowledgeText(seller) {
  const k = seller.knowledge || {};
  const parts = KNOWLEDGE_SECTIONS.filter(([key]) => k[key]?.trim()).map(([key, title]) => `## ${title}\n${k[key].trim()}`);
  if (k.never?.trim()) parts.push(`## Never say or promise this\n${k.never.trim()}`);
  return parts.length ? parts.join('\n\n').slice(0, 8000) : 'Nothing extra yet.';
}

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
    business_knowledge: knowledgeText(seller),
    // The sheet can say a business was never emailed; otherwise they were.
    outreach_history: lead.emailed === 0
      ? `${seller.yourName || 'The team'} hasn't been in touch with them before; this is the first contact.`
      : `A few days ago ${seller.yourName || 'the team'} emailed them about it, and you're following up because emails get buried.`,
    price_answer: seller.price
      ? `It's ${seller.price}. Say it simply, then point out the preview is free to look at first.`
      : `Say ${seller.yourName || 'the team'} will go over pricing personally, it depends on what they need, and the preview is free.`,
  };
}

// recording: calls are recorded, so the AI must say so (some US states require everyone's consent).
// transfer: 'available' (the owner can be connected live), 'unavailable', or 'missed' (we just tried and
//   he didn't pick up; history holds the conversation so far, so the AI can pick it back up).
// inbound: 'known' (a business from the list calling back) or 'unknown' (a number we don't have).
// booking: Cal.com is set up, so the AI books calls with the owner instead of vaguely promising one.
// callbacks: the AI can book a time for us to call back (schedule_callback); localNow is their current time.
// menus: an outbound call that may hit a phone menu (press_keys); keysPressed: we just pressed these
//   digits and the call is picking back up (history holds the conversation so far).
export function renderPrompt(template, lead, seller, {
  recording = false, transfer = 'unavailable', history = [], inbound = null, booking = false,
  callbacks = false, localNow = '', menus = false, keysPressed = null,
} = {}) {
  const vars = promptVariables(lead, seller);
  const name = seller.yourName || 'the owner';
  // Always first, whatever the edited script says: the AI is honest about being an AI.
  const always = '# Always\nYou are an AI voice assistant. Say so in your opening and whenever anyone asks. ' +
    'Never claim or suggest that you are a human.\n\n';
  const callBack = booking
    ? `book a quick call with ${name} for them (check_availability, then book_meeting)`
    : `offer that ${name} calls them back today, and get the best time and number for that`;
  let extra = lead.email ? `\n\n# Email on file\nThe email we have on file is ${lead.email}. Confirm it before sending.` : '';
  if (inbound === 'known') {
    extra += `\n\n# This is an incoming call\nThey are calling you: ${lead.business_name}, probably returning a call or replying to ` +
      `${name}'s email about the website preview. This replaces the opening above: you answer the phone, so speak first, right away. ` +
      `Something like: "Hi, thanks for calling back! This is ${seller.agentName}, an AI assistant for ${name}. ` +
      `Are you calling about the new website for ${lead.business_name}?" Then carry on as above, and close like you normally would.`;
  } else if (inbound === 'unknown') {
    extra += `\n\n# This is an incoming call from a number we don't know\nIgnore the details above about a specific business: ` +
      `you don't know who is calling. Speak first, right away: "Hi, thanks for calling ${name}, this is ${seller.agentName}, ` +
      `an AI assistant. How can I help?" Find out their name, their business and why they're calling. If they're a business owner ` +
      `calling about a website preview or ${name}'s email, get the business name and their email, explain the free redesign and ` +
      `continue as above (if there's no preview on file, say ${name} will email it today). For anything else, take a message: ` +
      `name, business, best number or email, and what it's about, and say ${name} will get back to them.`;
  }
  if (recording) {
    extra += '\n\n# This call is recorded\nIn your opening, right after saying you are an AI, add "and just so you know, this call is recorded." ' +
      'If they object, apologize, tell them you will make a note, and continue only if they are fine with it.';
  }
  if (transfer === 'available') {
    extra += `\n\n# Talking to ${name} live\nYou close the deal yourself; don't offer to hand them over. Only if they ask to speak to ${name} ` +
      `(or to "a real person", or the owner of the business you're calling for) and want to do it now: say something like ` +
      `"Sure, one sec, let me grab him for you", then call transfer_to_fardin with a one-sentence summary for ${name} ` +
      '(who they are and what they want). Say nothing after calling it.';
  } else if (transfer === 'unavailable') {
    extra += `\n\n# Talking to ${name} live\nIf they ask to speak to ${name} or a person right now: he can't jump on right this minute, ` +
      `so ${callBack}.`;
  } else if (transfer === 'missed') {
    const lines = history.slice(-20).map((t) => `${t.role === 'agent' ? 'You' : 'Them'}: ${t.message}`).join('\n');
    extra += `\n\n# Picking the call back up\nYou just tried to connect them to ${name}, but he couldn't pick up. ` +
      `Start right away with a short apology ("Sorry about that, looks like ${name} is tied up right now"), then ${callBack}, ` +
      'or email the preview. Keep it short. Don\'t introduce yourself again.' +
      (lines ? `\n\nThe conversation so far:\n${lines}` : '');
  }
  if (callbacks) {
    extra += `\n\n# Calling back at a time they pick\nRight now it is ${localNow} for them. If they (or whoever answers, like a ` +
      'receptionist) tell you a better time for you to call again ("try tomorrow after 2", "he\'s in Thursday morning"), agree and ' +
      'call schedule_callback with that day and time as YYYY-MM-DD HH:MM, 24-hour clock, their local time ("morning" = 10:00, ' +
      '"afternoon" = 14:00, "after lunch" = 13:30). Then confirm it back in a few words ("Perfect, I\'ll call Thursday at 10"). ' +
      'If it says the time won\'t work, suggest the closest time that does. ' +
      `Don't use it when they want ${name} himself to call them: that time is a note for him, not a call from you.`;
  }
  if (menus) {
    extra += '\n\n# Phone menus\nIf a recording answers with options ("press 1 for appointments..."), don\'t talk over it: ' +
      'pick the option most likely to reach the front desk, office manager or owner (often "all other questions" or 0) ' +
      'and call press_keys with that digit, saying nothing. Never pick options that leave a message, book an appointment, ' +
      'pay a bill, or reach an emergency line. If no option fits, wait for the menu to finish or press 0. ' +
      'If it\'s a dead end after a couple of tries, call end_call.';
  }
  if (keysPressed) {
    const lines = history.slice(-20).map((t) => `${t.role === 'agent' ? 'You' : 'Them'}: ${t.message}`).join('\n');
    extra += `\n\n# Back from the phone menu\nYou just pressed ${keysPressed} in their phone menu. Now listen: you may hear more ` +
      'options (use press_keys again), hold music or silence (say nothing), or a person. When a person answers, start your ' +
      'normal opening as if they just picked up.' + (lines ? `\n\nWhat was said so far:\n${lines}` : '');
  }
  if (booking) {
    extra += `\n\n# Booking a call with ${name}\nWhen they want to talk it through, need to think, or ask questions only ${name} can answer, ` +
      `book a quick call with him instead of promising one. Call check_availability, then offer two or three of the times it gives, ` +
      `naturally ("I've got Tuesday at 10 or Wednesday at 2, what works better?"). If they name a day, pass it as day. ` +
      'Once they pick, confirm their name and email (spell the email back), call book_meeting with that exact start, ' +
      'then confirm the day and time back to them. Never make up a time that check_availability didn\'t give you.';
  }
  return always + template.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? '') + extra;
}

// Used only if the person picks up and says nothing. Confirms the business first, like a person would.
export function firstGreeting(lead) {
  return `Hi, is this ${lead.business_name}?`;
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
    description: 'Hang up. Use after saying goodbye, or immediately on voicemail or wrong numbers.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', enum: ['finished', 'voicemail', 'wrong_number', 'not_interested', 'other'] } },
    },
  },
];

export const TRANSFER_TOOL = {
  type: 'function',
  name: 'transfer_to_fardin',
  description: 'Connect the caller to the owner live. Only when they ask to speak to him or a person now.',
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string', description: 'One sentence for the owner: who this is and what they want.' } },
    required: ['summary'],
  },
};

export const BOOKING_TOOLS = [
  {
    type: 'function',
    name: 'check_availability',
    description: 'Get open times for a call with the owner, in the business\'s timezone.',
    parameters: {
      type: 'object',
      properties: { day: { type: 'string', description: 'Optional day they asked for, as YYYY-MM-DD.' } },
    },
  },
  {
    type: 'function',
    name: 'book_meeting',
    description: 'Book the call at a time the person picked from check_availability.',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'The exact start value from check_availability.' },
        name: { type: 'string', description: 'Name of the person the call is with.' },
        email: { type: 'string', description: 'Their email, confirmed with them.' },
      },
      required: ['start', 'email'],
    },
  },
];

export const CALLBACK_TOOL = {
  type: 'function',
  name: 'schedule_callback',
  description: 'Book a time for us to call this business back, when they or their receptionist name one.',
  parameters: {
    type: 'object',
    properties: {
      when: { type: 'string', description: 'Day and time on their clock, as YYYY-MM-DD HH:MM (24-hour).' },
      note: { type: 'string', description: 'Who to ask for or anything to remember, e.g. "ask for Dr. Lee".' },
    },
    required: ['when'],
  },
};

export const KEYS_TOOL = {
  type: 'function',
  name: 'press_keys',
  description: 'Press keys in an automated phone menu, e.g. "1" or "0". Say nothing while doing it.',
  parameters: {
    type: 'object',
    properties: { digits: { type: 'string', description: 'Keys to press: 0-9, * or #. Usually a single digit.' } },
    required: ['digits'],
  },
};

export const realtimeTools = ({ transfer = false, booking = false, callbacks = false, menus = false } = {}) =>
  [...REALTIME_TOOLS, ...(transfer ? [TRANSFER_TOOL] : []), ...(booking ? BOOKING_TOOLS : []),
    ...(callbacks ? [CALLBACK_TOOL] : []), ...(menus ? [KEYS_TOOL] : [])];

// Maps the call outcome to a lead status.
export const OUTCOME_STATUS = {
  transferred: 'interested',
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
// What the after-call analysis may choose from ("transferred" is set by the system, not guessed).
export const OUTCOMES = Object.keys(OUTCOME_STATUS).filter((o) => o !== 'transferred');

export function followUpMessage(lead, name, seller) {
  const lines = [
    name ? `Hi ${name},` : 'Hi,',
    '',
    `Thanks for taking the call just now. Here is the new website we put together for ${lead.business_name}:`,
    lead.demo_link,
    '',
  ];
  if (seller.bookingLink) lines.push(`If you'd like to go over it together, grab a time here: ${seller.bookingLink}`, '');
  if (seller.paymentLink) lines.push(`When you're ready to go live, you can get started here: ${seller.paymentLink}`, '');
  lines.push('Just reply to this email with any questions or changes you want.', '', seller.yourName || '', seller.company || '');
  return lines.join('\n').trim();
}
