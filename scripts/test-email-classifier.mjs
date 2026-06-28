import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolve } from 'path';

const ROOT = process.cwd();

async function classify(label, subject, from, body) {
  const prompt = `Subject: ${subject}\nFrom: ${from}\nBody: ${body}`;
  let result = null;
  for await (const msg of query({
    prompt: `Classify this email from a job application process. Return only the JSON object.\n\n${prompt}`,
    options: {
      cwd: ROOT,
      agent: 'email-classifier',
      maxTurns: 3,
      allowedTools: [],
      jsonSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['rejection', 'interview_invite', 'confirmation', 'irrelevant'] },
          company: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['category', 'company', 'confidence'],
      },
    },
  })) {
    console.log('  MSG:', msg.type, JSON.stringify(msg).slice(0, 200));
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          const match = block.text.match(/\{[\s\S]*\}/);
          if (match) try { result = JSON.parse(match[0]); } catch {}
        }
      }
    }
    if (msg.type === 'result') {
      const match = (msg.result || '').match(/\{[\s\S]*\}/);
      if (match) try { result = JSON.parse(match[0]); } catch {}
    }
  }
  const pass = result !== null;
  console.log(`\n[${pass ? '✓' : '✗'}] ${label}`);
  console.log('  →', JSON.stringify(result));
  return result;
}

console.log('Testing email-classifier sub-agent...\n');

await classify(
  'Rejection (polite)',
  'Product Monetization Manager position at Moon Active',
  'Reut Shiran <notifications@moonactive.comeet-notifications.com>',
  'Hi Noa, It was a real pleasure getting to know you. After careful consideration, we regret to inform you that we have decided to move forward with another candidate at this time. We will keep you in mind for future opportunities.'
);

await classify(
  'Rejection (direct)',
  'Thank you for applying for the Monetization Manager position at SuperPlay',
  'SuperPlay <no-reply@superplay.comeet-notifications.com>',
  'Hi Noa, Thank you for submitting your resume. After reviewing your experience and qualifications, we decided to move forward with other candidates. We wish you the best in your search.'
);

await classify(
  'Interview invite',
  'Interview Invitation — Junior PM at Wix',
  'Talent Team <talent@wix.com>',
  'Hi Noa, We were impressed by your application and would love to schedule a phone screen. Are you available this week? Please pick a time here: calendly.com/wix-talent'
);

await classify(
  'Application confirmation',
  'We Got It: Thanks for applying for AI Implementation Specialist',
  'abra <no-reply@abra.rnd.comeet-notifications.com>',
  'Hi, Thank you for applying for a position at abra. We received your information and will contact you if there is a good match.'
);

await classify(
  'Irrelevant (LinkedIn job alert)',
  'Your job alert for Product Manager',
  'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
  'New jobs matching your search: Product Manager at Wix, Product Manager at Monday.com, Senior PM at Fiverr...'
);

console.log('\nDone.');
