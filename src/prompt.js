import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const promptFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'sales-agent.md');

// Values for every {{placeholder}} in prompts/sales-agent.md. ElevenLabs needs all of
// them as dynamic variables; the OpenAI bridge fills them in itself.
export function promptVariables(lead) {
  const s = config.seller;
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
    agent_name: s.agentName,
    your_name: s.yourName || 'our team',
    your_company: s.company || 'our studio',
    offer_phrase: s.price ? ` (${s.price})` : '',
    price_answer: s.price
      ? `It's ${s.price}. Say it simply, then point out the preview is free to look at first.`
      : `Say ${s.yourName || 'the team'} will go over pricing personally, it depends on what they need, and the preview is free.`,
  };
}

export function renderPrompt(lead) {
  const vars = promptVariables(lead);
  const extra = lead.email ? `\n\n# Email on file\nThe email we have on file is ${lead.email}. Confirm it before sending.` : '';
  return fs.readFileSync(promptFile, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? '') + extra;
}

export function firstGreeting(lead) {
  const s = config.seller;
  const who = lead.contact_name ? `Could I speak with ${lead.contact_name}?` : 'Am I speaking with the owner?';
  return `Hi, this is ${s.agentName}, an AI assistant calling for ${s.yourName || 'the team'} at ${s.company || 'our studio'} about the ${lead.business_name} website. ${who}`;
}
