import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getAnnotations, createAnnotation, updateAnnotation, deleteAnnotation } from '@/app/actions/annotations'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; flightPlanId: string; flightId: string }> }
): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { flightId } = await params
  try {
    const annos = await getAnnotations(flightId)
    return NextResponse.json(annos)
  } catch (err) {
    console.error('[Annotations API GET] Error:', err)
    return NextResponse.json({ error: 'Failed to fetch annotations' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; flightPlanId: string; flightId: string }> }
): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { flightId } = await params
  try {
    const body = await request.json()
    const anno = await createAnnotation({
      flightId,
      shape: body.shape,
      geometry: body.geometry,
      fishCount: body.fishCount,
      confidence: body.confidence,
      fileId: body.fileId,
      label: body.label,
    })
    return NextResponse.json(anno)
  } catch (err) {
    console.error('[Annotations API POST] Error:', err)
    return NextResponse.json({ error: 'Failed to create annotation' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; flightPlanId: string; flightId: string }> }
): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await request.json()
    const { id, fishCount, confidence, geometry } = body
    if (!id) return NextResponse.json({ error: 'Missing annotation ID' }, { status: 400 })

    const anno = await updateAnnotation(id, { fishCount, confidence, geometry })
    return NextResponse.json(anno)
  } catch (err) {
    console.error('[Annotations API PATCH] Error:', err)
    return NextResponse.json({ error: 'Failed to update annotation' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; flightPlanId: string; flightId: string }> }
): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'Missing annotation ID' }, { status: 400 })

    await deleteAnnotation(id)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[Annotations API DELETE] Error:', err)
    return NextResponse.json({ error: 'Failed to delete annotation' }, { status: 500 })
  }
}
