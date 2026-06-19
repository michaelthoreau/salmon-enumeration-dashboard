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

  archive.on('error', (err: Error) => {
    console.error('[zip] Archive error:', err)
    passthrough.destroy(err)
  })

  archive.pipe(passthrough)

  ;(async () => {
    try {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]
        try {
          const stream = await getObjectStream(key)
          const filename = key.split('/').pop() ?? key
          archive.append(stream, { name: filename })
          console.log(`[zip] ${i + 1}/${keys.length}: ${filename}`)
        } catch (err) {
          console.error(`[zip] Failed ${key}:`, err)
        }
      }
      await archive.finalize()
      console.log(`[zip] Done: ${keys.length} files`)
    } catch (err) {
      console.error('[zip] Fatal error:', err)
      passthrough.destroy(err as Error)
    }
  })()

  const webStream = new ReadableStream({
    start(controller) {
      passthrough.on('data', (chunk: Buffer) => controller.enqueue(chunk))
      passthrough.on('end', () => controller.close())
      passthrough.on('error', (err) => {
        console.error('[zip] Stream error:', err)
        controller.error(err)
      })
    },
  })

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}.zip"`,
    },
  })
}
