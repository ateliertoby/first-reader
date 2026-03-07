import { graphPost } from '../graph.js';

export async function send(options) {
  if (!options.to || !options.subject) {
    console.error('Required: --to and --subject');
    process.exit(1);
  }

  const body = options.body || '';

  await graphPost('/me/sendMail', {
    message: {
      toRecipients: [{ emailAddress: { address: options.to } }],
      subject: options.subject,
      body: { contentType: 'Text', content: body }
    }
  });

  console.log(`Sent to ${options.to}.`);
}
