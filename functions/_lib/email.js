// Sends the magic-link login email via Resend's REST API
// (https://resend.com/docs/api-reference/emails/send-email). Cloudflare's own
// Email Sending API was tried first but needs a Workers Paid plan to send to
// arbitrary recipients; Resend's free tier (3,000/mo) has no such Cloudflare
// plan dependency. This is the only file that talks to the email provider --
// swapping providers again later only means editing this one function.
//
// Required env: RESEND_API_KEY, EMAIL_FROM (a verified sender on a domain
// that's been added + DNS-verified in the Resend dashboard).

export async function sendMagicLinkEmail(env, toEmail, link) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error('EMAIL_NOT_CONFIGURED');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: toEmail,
      from: env.EMAIL_FROM,
      subject: 'Your holdat login link',
      html: `<p>Click below to log in. This link expires in 15 minutes.</p><p><a href="${link}">${link}</a></p>`,
      text: `Click to log in (expires in 15 minutes): ${link}`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`EMAIL_SEND_FAILED: ${res.status} ${body}`);
  }
}

// Sends a commissioner-issued franchise-claim invite. Same Resend call shape
// as sendMagicLinkEmail, different (longer-lived, one-time) content.
export async function sendInviteEmail(env, toEmail, link, franchiseName) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error('EMAIL_NOT_CONFIGURED');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: toEmail,
      from: env.EMAIL_FROM,
      subject: `You've been invited to claim ${franchiseName} on Holdat`,
      html: `<p>You've been invited to claim <strong>${franchiseName}</strong> in the Holdat league. Click below to set up your account. This link expires in 7 days.</p><p><a href="${link}">${link}</a></p>`,
      text: `You've been invited to claim ${franchiseName} in the Holdat league. Set up your account (expires in 7 days): ${link}`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`EMAIL_SEND_FAILED: ${res.status} ${body}`);
  }
}
