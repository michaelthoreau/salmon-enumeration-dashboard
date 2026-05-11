import * as React from 'react'
import { render } from 'react-email'
import { ServerClient } from 'postmark'
import OtpEmail from '@/emails/otp-email'
import InviteEmail from '@/emails/invite-email'
import type { Role } from './schema'

function getClient(): ServerClient {
  const token = process.env.POSTMARK_SERVER_TOKEN
  if (!token) throw new Error('POSTMARK_SERVER_TOKEN environment variable is not set')
  return new ServerClient(token)
}

function getFromAddress(): string {
  const from = process.env.EMAIL_FROM
  if (!from) throw new Error('EMAIL_FROM environment variable is not set')
  return from
}

export async function sendOtpEmail(toEmail: string, otp: string): Promise<void> {
  const html = await render(React.createElement(OtpEmail, { otp }))
  const text = await render(React.createElement(OtpEmail, { otp }), { plainText: true })

  await getClient().sendEmail({
    From: getFromAddress(),
    To: toEmail,
    Subject: `${otp} is your login code`,
    HtmlBody: html,
    TextBody: text,
    MessageStream: 'outbound',
  })
}

export async function sendInviteEmail(
  toEmail: string,
  role: Role,
  invitedByEmail: string,
): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const loginUrl = `${appUrl}/login`

  const html = await render(
    React.createElement(InviteEmail, { toEmail, role, invitedByEmail, loginUrl }),
  )
  const text = await render(
    React.createElement(InviteEmail, { toEmail, role, invitedByEmail, loginUrl }),
    { plainText: true },
  )

  await getClient().sendEmail({
    From: getFromAddress(),
    To: toEmail,
    Subject: "You've been invited to Salmon Enumeration Dashboard",
    HtmlBody: html,
    TextBody: text,
    MessageStream: 'outbound',
  })
}
