'use client';

import { Drawer } from './Drawer';

const QA: [string, string][] = [
  ['What is ASK IT?', 'A voice IT helpdesk. You say what is wrong; ASK IT checks for outages, walks you through a guided fix one step at a time, unlocks or resets your account after a quick identity check, and raises a ServiceNow ticket only when the fix does not work. IT follows along on the IT dashboard.'],
  ['What can I say?', '“My VPN keeps disconnecting.” · “I’m locked out of my account.” · “Is Slack down?” · “What’s the status of my tickets?” · “Escalate my ticket, I have a client call in an hour.” · “Wrap up the call.”'],
  ['Will it change things without asking?', 'No. Account unlocks and resets, new tickets and escalations are prepared first; the screen shows “Waiting for your OK” with a short code and a 5 minute expiry. Nothing happens until you say yes, and saying no drops it.'],
  ['How does the identity check work?', 'Before any account change ASK IT emails a 6-digit code to your work address through Auth0, and you read it back on the call. You get three tries, and a verification lasts 10 minutes. In simulated mode no email is sent; the code appears in a “Simulated inbox” card instead.'],
  ['What happens when something is already down?', 'If there is a known outage, ASK IT says so and adds you to the master incident as affected instead of opening a duplicate ticket. Public services such as Slack, GitHub, Jira and Google Workspace are checked live on their status pages.'],
  ['Is the data real?', 'Nimbus Labs, Priya and the seeded tickets and outage are fictional. ServiceNow, Auth0 and the Slack or Discord alert are live only when their keys are configured; otherwise each card is marked Simulated. Each session gets its own copy of the data.'],
  ['How does the IT dashboard update?', 'It polls this session about once a second and only re-renders when something changed: tickets, outages, top issues, live activity and what was fixed without IT.'],
  ['What powers the voice?', 'Agora Conversational AI Engine runs speech recognition, the language model and the tool calls; Murf Falcon speaks the replies in an Indian-English voice.'],
  ['Why does the call end after 10 minutes?', 'Demo sessions are capped at 10 minutes, like Agora’s official demos. Start a new call to continue; your session data stays for a few hours.'],
];

export function Faq({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer title="FAQ" open={open} onClose={onClose}>
      <div className="wc-faq">
        {QA.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </Drawer>
  );
}
