import * as React from 'react'
import { Html, Head, Body, Container, Heading, Text, Section, Button, Hr } from 'react-email'
import type { Role } from '@/lib/schema'

interface InviteEmailProps {
  toEmail: string
  role: Role
  invitedByEmail: string
  magicLink: string
  appUrl: string
  appName?: string
}

export default function InviteEmail({
  toEmail,
  role,
  invitedByEmail,
  magicLink,
  appUrl,
  appName = 'Salmon Enumeration Dashboard',
}: InviteEmailProps) {
  const roleLabel: Record<Role, string> = {
    read: 'Viewer (read-only)',
    'read-write': 'Editor (read & write)',
    admin: 'Administrator',
  }

  const loginUrl = `${appUrl}/login?email=${encodeURIComponent(toEmail)}`

  return (
    <Html lang="en">
      <Head />
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>You've been invited</Heading>
          <Text style={text}>
            <strong>{invitedByEmail}</strong> has invited you ({toEmail}) to join{' '}
            <strong>{appName}</strong> as a <strong>{roleLabel[role]}</strong>.
          </Text>
          <Section style={ctaSection}>
            <Text style={ctaText}>
              Click the button below to sign in — no password required. This link expires in{' '}
              <strong>10 minutes</strong>.
            </Text>
            <Button href={magicLink} style={button}>
              Sign in to {appName}
            </Button>
          </Section>
          <Hr style={hr} />
          <Text style={footer}>
            If the link has expired, you can{' '}
            <a href={loginUrl} style={footerLink}>
              request a new code
            </a>{' '}
            from the sign-in page. If you believe this was sent in error, you can ignore this
            email.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const body: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
}

const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e6ebf1',
  borderRadius: '8px',
  margin: '40px auto',
  maxWidth: '480px',
  padding: '40px',
}

const h1: React.CSSProperties = {
  color: '#1a1a1a',
  fontSize: '24px',
  fontWeight: '600',
  margin: '0 0 20px',
}

const text: React.CSSProperties = {
  color: '#4a4a4a',
  fontSize: '15px',
  lineHeight: '24px',
  margin: '0 0 16px',
}

const ctaSection: React.CSSProperties = {
  backgroundColor: '#f4f7ff',
  borderRadius: '6px',
  margin: '24px 0',
  padding: '20px',
}

const ctaText: React.CSSProperties = {
  color: '#4a4a4a',
  fontSize: '14px',
  margin: '0 0 16px',
}

const button: React.CSSProperties = {
  backgroundColor: '#2563eb',
  borderRadius: '6px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '15px',
  fontWeight: '600',
  padding: '12px 24px',
  textDecoration: 'none',
}

const hr: React.CSSProperties = {
  borderColor: '#e6ebf1',
  margin: '24px 0',
}

const footer: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '0',
}

const footerLink: React.CSSProperties = {
  color: '#6b7280',
  textDecoration: 'underline',
}
