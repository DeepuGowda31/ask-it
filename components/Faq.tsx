'use client';

import { Drawer } from './Drawer';

const QA: [string, string][] = [
  ['What is ASK IT?', 'A voice IT helpdesk. You say what is wrong and ASK IT checks for outages, walks you through a guided fix one step at a time, unlocks or resets your account after a quick identity check, and raises a ServiceNow ticket only when the fix does not work. IT follows along in IT Operations.'],
  ['What can I say?', 'Anything you would tell the service desk. For example “My VPN keeps disconnecting”, “I’m locked out of my account”, “Is Slack down?”, “What’s the status of my tickets?”, “Escalate my ticket, I have a client call in an hour” or “Wrap up the call”.'],
  ['Will it change things without asking?', 'No. Account unlocks and resets, new tickets and escalations are prepared first, and the screen asks you to say yes within 5 minutes. Nothing happens until you do, and saying no drops it.'],
  ['How does the identity check work?', 'Before any account change ASK IT emails a 6 digit code to your work address through Auth0, and you read it back on the call. You get three tries, and a verification lasts 10 minutes. In simulated mode no email is sent and the code appears in a “Simulated inbox” card instead.'],
  ['What happens when something is already down?', 'If there is a known outage, ASK IT says so and adds you to the master incident as affected instead of opening a duplicate ticket. Public services such as Slack, GitHub, Jira and Google Workspace are checked live on their status pages.'],
  ['Is the data real?', 'ServiceNow, Auth0 and the Slack or Discord alert are live when their keys are configured. Otherwise each card is marked Simulated and uses fictional sample data for Nimbus Labs. Each session gets its own copy of that data.'],
  ['How does IT Operations update?', 'It polls this session about once a second and only re-renders when something changed, such as tickets, outages, top issues, live activity and what was fixed without IT.'],
  ['What powers the voice?', 'Agora Conversational AI Engine runs speech recognition, the language model and the tool calls. Murf Falcon speaks the replies in an Indian English voice.'],
  ['Why does a call end after 10 minutes?', 'Calls are capped at 10 minutes. Start a new call to continue. Your session data stays for a few hours.'],
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
