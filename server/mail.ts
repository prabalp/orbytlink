// Outgoing email through Resend's HTTPS API. Optional: without RESEND_API_KEY and MAIL_FROM
// nothing is sent and callers fall back to showing the link to copy.
export const mailConfigured = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

export type Mail = { to: string; subject: string; text: string; html: string };

export async function sendMail(mail: Mail) {
  if (!mailConfigured()) throw new Error("Email is not configured.");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    // Resend explains failures (unverified domain, bad key) in `message`; log it, never the key.
    const detail = await r.json().then((b: any) => b?.message, () => undefined);
    console.error(`[mail] Resend refused the message (${r.status}): ${detail ?? "no detail"}`);
    throw new Error("The email could not be sent.");
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The wording is fixed: admins choose only the role, so the message can't be turned into spam.
export function inviteMail({ to, inviter, org, role, link, days }: { to: string; inviter: string; org: string; role: string; link: string; days: number }): Mail {
  const as = role === "admin" ? "an admin" : "a member";
  const subject = `${inviter} invited you to ${org} on OrbytLink`;
  const text = `${inviter} invited you to join ${org} on OrbytLink as ${as}.

OrbytLink connects your team's apps to AI agents like Claude through one endpoint.

Accept the invite: ${link}

The link works once and expires in ${days} days. If you weren't expecting this, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f5f5f5;font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0a0a0a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<tr><td style="padding:32px">
<p style="margin:0 0 16px;font-size:14px;font-weight:600">OrbytLink</p>
<p style="margin:0 0 12px;font-size:16px;line-height:24px"><strong>${escape(inviter)}</strong> invited you to join <strong>${escape(org)}</strong> as ${as}.</p>
<p style="margin:0 0 24px;font-size:14px;line-height:20px;color:#737373">OrbytLink connects your team's apps to AI agents like Claude through one endpoint.</p>
<a href="${escape(link)}" style="display:inline-block;padding:10px 16px;background:#0a0a0a;color:#ffffff;border-radius:8px;font-size:14px;font-weight:500;text-decoration:none">Accept invite</a>
<p style="margin:24px 0 0;font-size:12px;line-height:18px;color:#737373">The link works once and expires in ${days} days. If you weren't expecting this, you can ignore this email.</p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#a3a3a3">${escape(to)}</p>
</td></tr></table></body></html>`;
  return { to, subject, text, html };
}
