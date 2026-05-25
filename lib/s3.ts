import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

function getClient(): S3Client {
  const region = process.env.AWS_REGION
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS credentials environment variables')
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
}

export function getBucket(): string {
  const bucket = process.env.S3_BUCKET_NAME
  if (!bucket) throw new Error('S3_BUCKET_NAME environment variable is not set')
  return bucket
}

/** Canonical S3 prefix for a flight's data — uses stable IDs, never slugs */
export function flightPrefix(
  projectId: string,
  flightPlanId: string,
  flightId: string,
): string {
  return `${projectId}/${flightPlanId}/${flightId}/`
}

/** List all objects under a flight prefix */
export async function listFlightObjects(
  projectId: string,
  flightPlanId: string,
  flightId: string,
): Promise<{ key: string; size: number; lastModified: Date; etag: string }[]> {
  const client = getClient()
  const bucket = getBucket()
  const prefix = flightPrefix(projectId, flightPlanId, flightId)

  const results: { key: string; size: number; lastModified: Date; etag: string }[] = []
  let continuationToken: string | undefined

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    for (const obj of response.Contents ?? []) {
      if (obj.Key) {
        results.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(),
          // Strip surrounding quotes S3 wraps ETags in
          etag: (obj.ETag ?? '').replace(/"/g, ''),
        })
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)

  return results
}

/** Generate a presigned POST policy for a single file upload.
 *  Presigned POST supports browser-direct uploads with a 5 GB limit per part.
 *  Expires in 15 minutes. */
export async function createPresignedUploadPost(
  projectId: string,
  flightPlanId: string,
  flightId: string,
  fileName: string,
  contentType: string,
  maxFileSizeBytes: number = 5 * 1024 * 1024 * 1024, // 5 GB
): Promise<{ url: string; fields: Record<string, string> }> {
  const client = getClient()
  const bucket = getBucket()
  const key = `${flightPrefix(projectId, flightPlanId, flightId)}${fileName}`

  return createPresignedPost(client, {
    Bucket: bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 0, maxFileSizeBytes],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: 900, // 15 minutes
  })
}

/** Generate a short-lived presigned GET URL for viewing/downloading a file */
export async function createPresignedGetUrl(
  key: string,
  expiresInSeconds = 3600,
  disposition?: 'inline' | 'attachment',
): Promise<string> {
  const client = getClient()
  const filename = key.split('/').pop()
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
      ...(disposition === 'attachment' && filename
        ? { ResponseContentDisposition: `attachment; filename="${filename}"` }
        : {}),
    }),
    { expiresIn: expiresInSeconds },
  )
}

/** Soft-delete by removing an object from S3 (actual delete, but flight row stays soft-deleted in DB) */
export async function deleteObject(key: string): Promise<void> {
  const client = getClient()
  await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }))
}

/** Fetch metadata for an S3 object, including its ETag */
export async function headObject(key: string): Promise<{ etag: string; contentLength: number }> {
  const client = getClient()
  const response = await client.send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }))
  return {
    etag: (response.ETag ?? '').replace(/"/g, ''),
    contentLength: response.ContentLength ?? 0,
  }
}

/** Check whether an S3 key exists */
export async function objectExists(key: string): Promise<boolean> {
  const client = getClient()
  try {
    await client.send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }))
    return true
  } catch {
    return false
  }
}
