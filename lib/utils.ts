import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Normalizes an email address for consistent storage and matching.
 * For Gmail (gmail.com / googlemail.com), dots in the local part are ignored
 * by Google, so we strip them to treat e.g. "john.doe" and "johndoe" as equal.
 */
export function normalizeEmail(raw: string): string {
  const email = raw.toLowerCase().trim()
  const atIdx = email.lastIndexOf('@')
  if (atIdx === -1) return email
  const local = email.slice(0, atIdx)
  const domain = email.slice(atIdx + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.replace(/\./g, '')}@${domain}`
  }
  return email
}
