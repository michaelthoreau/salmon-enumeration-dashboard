import { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getObjectStream } from '@/lib/s3'
import { ZipArchive } from 'archiver'
import { PassThrough } from 'stream'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return new Response('Unauthorized', { status: 403 })
  }

  let body: { keys: string[]; zipName?: string }
  try {
    body = await request.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  const { keys, zipName = 'download' } = body

  if (!Array.isArray(keys) || keys.length === 0) {
    return new Response('keys[] is required', { status: 400 })
  }

  if (keys.length > 500) {
    return new Response('Maximum 500 files per zip', { status: 400 })
  }

  const passthrough = new PassThrough()

  const archive = new ZipArchive({ store: true })
  archive.pipe(passthrough)

  ;(async () => {
    for (const key of keys) {
      try {
        const stream = await getObjectStream(key)
        const filename = key.split('/').pop() ?? key
        archive.append(stream, { name: filename })
      } catch (err) {
        console.error(`Failed to add ${key} to zip:`, err)
      }
    }
    await archive.finalize()
  })()

  const webStream = new ReadableStream({
    start(controller) {
      passthrough.on('data', (chunk: Buffer) => controller.enqueue(chunk))
      passthrough.on('end', () => controller.close())
      passthrough.on('error', (err) => controller.error(err))
    },
  })

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}.zip"`,
    },
  })
}
