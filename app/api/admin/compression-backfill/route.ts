import { NextRequest, NextResponse } from 'next/server'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { getSession } from '@/lib/session'

function getLambdaClient() {
  const region = process.env.AWS_REGION
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS credentials environment variables')
  }
  return new LambdaClient({ region, credentials: { accessKeyId, secretAccessKey } })
}

// POST /api/admin/compression-backfill
// Body: { keys: string[] }
// Invokes the compression Lambda for each key with a synthetic S3 event.
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const functionName = process.env.COMPRESS_LAMBDA_FUNCTION_NAME
  if (!functionName) {
    return NextResponse.json({ error: 'COMPRESS_LAMBDA_FUNCTION_NAME env var not set' }, { status: 500 })
  }

  let body: { keys: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { keys } = body
  if (!Array.isArray(keys) || keys.length === 0) {
    return NextResponse.json({ error: 'keys must be a non-empty array' }, { status: 400 })
  }

  const lambda = getLambdaClient()
  const results: { key: string; status: 'invoked' | 'error'; error?: string }[] = []

  for (const key of keys) {
    const syntheticEvent = {
      Records: [{ s3: { object: { key } } }],
    }

    try {
      await lambda.send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event', // async — fire and forget
        Payload: Buffer.from(JSON.stringify(syntheticEvent)),
      }))
      results.push({ key, status: 'invoked' })
    } catch (err) {
      results.push({ key, status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  return NextResponse.json({ results })
}
