// Lazy-loaded mailer — server starts fine even if nodemailer is not installed.
// Emails are silently skipped if SMTP is not configured or nodemailer is missing.

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;
  try {
    const nodemailer = await import('nodemailer');
    transporter = nodemailer.default.createTransport({
      host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
      port: parseInt(process.env.SMTP_PORT || '587'),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    return transporter;
  } catch {
    console.log('[Mailer] nodemailer not installed — skipping emails.');
    return null;
  }
}

const FROM = process.env.SMTP_FROM || '"RUNSA Voting Portal" <noreply@runsa.edu.ng>';

export async function sendElectionOpenEmail(voters, election) {
  if (!process.env.SMTP_USER) {
    console.log('[Mailer] SMTP not configured. Skipping open email.');
    return;
  }
  const t = await getTransporter();
  if (!t) return;

  const emails = voters.map((v) => v.schoolEmail).filter(Boolean);
  if (emails.length === 0) return;

  await t.sendMail({
    from: FROM,
    bcc: emails,
    subject: `🗳️ Voting is now OPEN — ${election.title}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #0c1a3a; color: white; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 22px;">RUNSA Digital Voting Portal</h1>
        </div>
        <div style="padding: 24px; border: 1px solid #e2e4ea; border-top: none; border-radius: 0 0 8px 8px;">
          <h2 style="color: #0c1a3a;">Voting is now Open!</h2>
          <p>The election <strong>${election.title}</strong> has just opened for voting.</p>
          <p>Log in to cast your vote before the deadline on <strong>${new Date(election.endAt).toLocaleString()}</strong>.</p>
          <a href="${process.env.APP_URL || 'http://localhost:3000'}/login"
             style="display:inline-block;margin-top:16px;padding:12px 24px;background:#0c1a3a;color:white;text-decoration:none;border-radius:8px;font-weight:600;">
            Vote Now →
          </a>
          <p style="color:#9da2b0;font-size:12px;margin-top:24px;">You are receiving this because you are an eligible voter in this election.</p>
        </div>
      </div>`,
  });
  console.log(`[Mailer] Sent open email to ${emails.length} voter(s)`);
}

export async function sendElectionCloseEmail(voters, election) {
  if (!process.env.SMTP_USER) {
    console.log('[Mailer] SMTP not configured. Skipping close email.');
    return;
  }
  const t = await getTransporter();
  if (!t) return;

  const emails = voters.map((v) => v.schoolEmail).filter(Boolean);
  if (emails.length === 0) return;

  await t.sendMail({
    from: FROM,
    bcc: emails,
    subject: `🔒 Voting Closed — ${election.title}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #0c1a3a; color: white; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 22px;">RUNSA Digital Voting Portal</h1>
        </div>
        <div style="padding: 24px; border: 1px solid #e2e4ea; border-top: none; border-radius: 0 0 8px 8px;">
          <h2 style="color: #0c1a3a;">Voting has Closed</h2>
          <p>The election <strong>${election.title}</strong> has now closed. Results will be published shortly.</p>
          <a href="${process.env.APP_URL || 'http://localhost:3000'}/vote/results"
             style="display:inline-block;margin-top:16px;padding:12px 24px;background:#0c1a3a;color:white;text-decoration:none;border-radius:8px;font-weight:600;">
            View Results →
          </a>
          <p style="color:#9da2b0;font-size:12px;margin-top:24px;">Thank you for participating in RUNSA elections.</p>
        </div>
      </div>`,
  });
  console.log(`[Mailer] Sent close email to ${emails.length} voter(s)`);
}
