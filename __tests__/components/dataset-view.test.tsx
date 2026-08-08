// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import DatasetView from '@/app/projects/[projectId]/dataset/dataset-view'
import type { DatasetEntry } from '@/app/actions/files'

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}))

// Mock server actions
vi.mock('@/app/actions/files', () => ({
  assignFileSplit: vi.fn().mockResolvedValue({ success: true }),
  loadDatasetEntriesBefore: vi.fn().mockResolvedValue({ entries: [], taskCounts: {}, hasMore: false }),
  randomlyAssignSplits: vi.fn().mockResolvedValue({ ok: true, counts: { train: 0, val: 0, test: 0 } }),
}))

// Mock createLabelingTasks server action
vi.mock('@/app/actions/labeling-tasks', () => ({
  createLabelingTasks: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
}))

const mockEntries: DatasetEntry[] = [
  {
    fileId: 'f1',
    key: 'flight-1/img_1.jpg',
    etag: 'etag1',
    split: null,
    imageWidth: 640,
    imageHeight: 480,
    size: 1024,
    reviewRating: null,
    durationSeconds: null,
    flightId: 'fl1',
    flightPlanId: 'fp1',
    flightTimestampIso: '2026-06-11T20:00:00Z',
    flightPlanName: 'Flight Plan 1',
    surveyType: 'migration',
    uploadedAtIso: '2026-06-11T20:00:00Z',
  },
  {
    fileId: 'f2',
    key: 'flight-1/img_2.jpg',
    etag: 'etag2',
    split: null,
    imageWidth: 640,
    imageHeight: 480,
    size: 2048,
    reviewRating: null,
    durationSeconds: null,
    flightId: 'fl1',
    flightPlanId: 'fp1',
    flightTimestampIso: '2026-06-11T20:00:00Z',
    flightPlanName: 'Flight Plan 1',
    surveyType: 'migration',
    uploadedAtIso: '2026-06-11T20:00:00Z',
  },
  {
    fileId: 'f3',
    key: 'flight-1/img_3.jpg',
    etag: 'etag3',
    split: null,
    imageWidth: 640,
    imageHeight: 480,
    size: 4096,
    reviewRating: null,
    durationSeconds: null,
    flightId: 'fl1',
    flightPlanId: 'fp1',
    flightTimestampIso: '2026-06-11T20:00:00Z',
    flightPlanName: 'Flight Plan 1',
    surveyType: 'migration',
    uploadedAtIso: '2026-06-11T20:00:00Z',
  },
]

describe('DatasetView Lightbox Carousel', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    originalFetch = global.fetch
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/files/presign')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ url: 'http://example.com/presigned-url' }),
        })
      }
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({}),
      })
    }) as any
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('allows clicking an image filename to open lightbox, and next/prev buttons traverse images', async () => {
    render(
      <DatasetView
        entries={mockEntries}
        projectId="proj1"
        taskCountByFileId={new Map()}
        canWrite={true}
        timezone="UTC"
        hasMore={false}
        globalCounts={{ train: 0, val: 0, test: 0, unassigned: 3 }}
      />
    )

    // Initially lightbox is not open (no image preview text)
    expect(screen.queryByText(/image preview/i)).toBeNull()

    // Click on img_1.jpg to open lightbox
    const img1Link = screen.getByText('img_1.jpg')
    fireEvent.click(img1Link)

    // Now lightbox is open
    expect(await screen.findByText(/image preview/i)).toBeDefined()
    expect(await screen.findByText('1 of 3')).toBeDefined()

    // Click on next button (it should traverse to img_2.jpg)
    const nextBtn = await screen.findByRole('button', { name: /next image/i })
    fireEvent.click(nextBtn)

    // Now active image should be img_2.jpg
    expect(await screen.findByText('2 of 3')).toBeDefined()

    // Click on next button again (it should traverse to img_3.jpg)
    const nextBtn2 = await screen.findByRole('button', { name: /next image/i })
    fireEvent.click(nextBtn2)

    // Now active image should be img_3.jpg
    expect(await screen.findByText('3 of 3')).toBeDefined()

    // Click prev button (should go back to img_2.jpg)
    const prevBtn = await screen.findByRole('button', { name: /previous image/i })
    fireEvent.click(prevBtn)

    expect(await screen.findByText('2 of 3')).toBeDefined()
  })

  it('keeps navigation intact and active index stable when changing split of the active image', async () => {
    render(
      <DatasetView
        entries={mockEntries}
        projectId="proj1"
        taskCountByFileId={new Map()}
        canWrite={true}
        timezone="UTC"
        hasMore={false}
        globalCounts={{ train: 0, val: 0, test: 0, unassigned: 3 }}
      />
    )

    // Click on img_1.jpg to open lightbox
    const img1Link = screen.getByText('img_1.jpg')
    fireEvent.click(img1Link)

    expect(await screen.findByText('1 of 3')).toBeDefined()

    // Change split of img_1.jpg to train
    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'train' } })

    // The lightbox list should remain frozen as size 3 (img_1, img_2, img_3)
    // so active index doesn't fall to -1 and next button remains visible
    expect(await screen.findByText('1 of 3')).toBeDefined()

    const nextBtn = await screen.findByRole('button', { name: /next image/i })
    expect(nextBtn).toBeDefined()

    // Can navigate to the next image even though the first image is now in 'train' split
    fireEvent.click(nextBtn)
    expect(await screen.findByText('2 of 3')).toBeDefined()
  })
})
