import ExifReader from 'exifreader'
import { getObjectRange } from './s3'

/**
 * Fetch a small byte range from S3 (first 64KB) and extract GPS coordinates (Latitude & Longitude).
 * Returns null if no GPS data is present or extraction fails.
 */
export async function extractExifGps(
  key: string,
): Promise<{ latitude: number; longitude: number } | null> {
  // Only try to parse EXIF for image file types
  const lower = key.toLowerCase()
  const isImage = lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')
  if (!isImage) return null

  try {
    // Fetch the first 64KB where EXIF header resides
    const { body } = await getObjectRange(key, 'bytes=0-65535')
    const tags = ExifReader.load(Buffer.from(body), { expanded: true })

    if (
      tags.gps &&
      typeof tags.gps.Latitude === 'number' &&
      typeof tags.gps.Longitude === 'number'
    ) {
      return {
        latitude: tags.gps.Latitude,
        longitude: tags.gps.Longitude,
      }
    }
  } catch (err) {
    console.warn(`[EXIF] Failed to parse GPS for key ${key}:`, err)
  }
  return null
}
