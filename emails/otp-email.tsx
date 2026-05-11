import * as React from 'react'
import { Html, Head, Body, Container, Heading, Text, Section, Hr } from 'react-email'

interface OtpEmailProps {
  otp: string
  appName?: string
}

export default function OtpEmail({ otp, appName = 'Salmon Enumeration Dashboard' }: OtpEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Your login code</Heading>
          <Text style={text}>
            Use the code below to sign in to {appName}. This code expires in{' '}
            <strong>10 minutes</strong>.
          </Text>
          <Section style={codeSection}>
            <Text style={codeText}>{otp}</Text>
          </Section>
          <Hr style={hr} />
          <Text style={footer}>
            If you did not request this code, you can safely ignore this email.
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
  margin: '0 0 20px',
}

const codeSection: React.CSSProperties = {
  backgroundColor: '#f4f7ff',
  borderRadius: '6px',
  margin: '24px 0',
  padding: '20px',
  textAlign: 'center',
}

const codeText: React.CSSProperties = {
  color: '#1a1a1a',
  fontSize: '40px',
  fontWeight: '700',
  letterSpacing: '12px',
  margin: '0',
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
