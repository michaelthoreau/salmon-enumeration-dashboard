// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import QueueAnnotator from '@/app/projects/[projectId]/labeling/queue/[queueId]/queue-annotator'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

const saveTaskPoints = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@/app/actions/labeling-tasks', () => ({
  saveTaskPoints: (...args: unknown[]) => saveTaskPoints(...args),
  setTaskComplete: vi.fn().mockResolvedValue({ ok: true }),
}))

const CONTAINER = { w: 1400, h: 800 }
const TILE = { w: 1024, h: 768 }

/**
 * jsdom has no layout engine, so the annotator's geometry (container size, the
 * post-transform rect of the media wrapper) has to be faked. The wrapper's rect
 * is derived from the transform the component actually set, which is what makes
 * these assertions meaningful: click coordinates are converted back through the
 * real transform.
 */
function stubLayout() {
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      this.cb([{ target: el, contentRect: { width: CONTAINER.w, height: CONTAINER.h } }] as never, this as never)
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)

  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement
    if (el.dataset.role === 'container') {
      return { left: 0, top: 0, width: CONTAINER.w, height: CONTAINER.h, right: CONTAINER.w, bottom: CONTAINER.h, x: 0, y: 0, toJSON: () => {} } as DOMRect
    }
    // Media wrapper: replay `translate(-50%,-50%) translate(pan) scale(zoom)`
    // with the transform origin at the top-left.
    const t = el.style.transform ?? ''
    const pan = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(t)
    const zoom = /scale\(([\d.]+)\)/.exec(t)
    const px = pan ? parseFloat(pan[1]) : 0
    const py = pan ? parseFloat(pan[2]) : 0
    const z = zoom ? parseFloat(zoom[1]) : 1
    const w = parseFloat(el.style.width) || 0
    const h = parseFloat(el.style.height) || 0
    const left = CONTAINER.w / 2 - w / 2 + px
    const top = CONTAINER.h / 2 - h / 2 + py
    return { left, top, width: w * z, height: h * z, right: left + w * z, bottom: top + h * z, x: left, y: top, toJSON: () => {} } as DOMRect
  }
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    queueId: 'q1',
    queueName: 'Ortho Queue',
    task: {
      id: 't1',
      fileId: 'f1',
      fileKey: 'flight-1/ortho_tile.jpg',
      x1: 0,
      y1: 0,
      x2: TILE.w,
      y2: TILE.h,
      frame: 0,
      completedBy: null,
      flightPlanName: 'Plan 1',
      surveyType: 'spawning' as const,
    },
    initialPoints: [],
    canWrite: true,
    positionInQueue: 1,
    totalInQueue: 10,
    completeCount: 0,
    prevTaskId: null,
    nextTaskId: 't2',
    queueTasks: [],
    ...overrides,
  }
}

/** The zoomable media wrapper — the only absolutely-positioned element with a scale transform. */
function wrapper(): HTMLElement {
  const el = document.querySelector('[style*="scale("]') as HTMLElement
  expect(el).toBeTruthy()
  return el
}

function markContainer() {
  // The wrapper's offset parent is the container div.
  const el = wrapper().parentElement as HTMLElement
  el.dataset.role = 'container'
  return el
}

describe('QueueAnnotator — image tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubLayout()
    localStorage.setItem('labeling-instructions-seen-q1', '1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob() }))
    global.URL.createObjectURL = vi.fn(() => 'blob:image')
  })

  it('shows a tile at native resolution rather than shrinking it to fit', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    const el = wrapper()
    // 1 CSS px per source px — the whole point of the default-zoom change.
    expect(el.style.width).toBe(`${TILE.w}px`)
    expect(el.style.height).toBe(`${TILE.h}px`)
    expect(screen.getByTitle(/reset zoom/i)).toHaveTextContent('100%')
  })

  it('shrinks an oversized legacy whole-image task to fit', async () => {
    const props = baseProps()
    props.task = { ...props.task, x2: 5280, y2: 3956 }
    await act(async () => { render(<QueueAnnotator {...props} />) })
    const el = wrapper()
    // min(1400/5280, 800/3956) = 0.2022 → 1068 × 800
    expect(parseFloat(el.style.width)).toBeLessThanOrEqual(CONTAINER.w)
    expect(parseFloat(el.style.height)).toBeLessThanOrEqual(CONTAINER.h)
    expect(screen.getByTitle(/reset zoom/i)).toHaveTextContent('20%')
  })

  it('zoom in / out buttons change the magnification and reset restores it', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    markContainer()

    fireEvent.click(screen.getByTitle(/zoom in/i))
    expect(screen.getByTitle(/reset zoom/i)).toHaveTextContent('125%')
    expect(wrapper().style.transform).toContain('scale(1.25)')

    fireEvent.click(screen.getByTitle(/zoom out/i))
    expect(screen.getByTitle(/reset zoom/i)).toHaveTextContent('100%')

    fireEvent.click(screen.getByTitle(/zoom in/i))
    fireEvent.click(screen.getByTitle(/zoom in/i))
    expect(screen.getByTitle(/reset zoom/i)).toHaveTextContent('156%')
    fireEvent.click(screen.getByTitle(/reset zoom/i))
    expect(screen.getByTitle(/reset zoom/i)).toHaveTextContent('100%')
    expect(wrapper().style.transform).toContain('scale(1)')
  })

  it('zooming with the buttons holds the centre of the viewport still', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    markContainer()

    const centreBefore = () => {
      const r = wrapper().getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    // The tile starts centred, so the viewport centre is the tile centre; after a
    // centre-anchored zoom it must still be the tile centre.
    const before = centreBefore()
    fireEvent.click(screen.getByTitle(/zoom in/i))
    const after = centreBefore()
    expect(after.x).toBeCloseTo(before.x, 4)
    expect(after.y).toBeCloseTo(before.y, 4)
  })

  it('places a point at the clicked source pixel, at any zoom', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    markContainer()

    // Click relative to the tile's centre, which stays put across a zoom step.
    const clickOffCentre = (dx: number, dy: number) => {
      const r = wrapper().getBoundingClientRect()
      fireEvent.click(wrapper(), {
        clientX: r.left + r.width / 2 + dx,
        clientY: r.top + r.height / 2 + dy,
      })
    }
    clickOffCentre(0, 0)
    fireEvent.click(screen.getByTitle(/zoom in/i))
    // At 125%, 100 screen px right of centre is 80 source px right of centre.
    clickOffCentre(100, 50)

    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(saveTaskPoints).toHaveBeenCalledWith('t1', [
      { x: TILE.w / 2, y: TILE.h / 2 },
      { x: TILE.w / 2 + 80, y: TILE.h / 2 + 40 },
    ])
  })
})

describe('QueueAnnotator — dense fish', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubLayout()
    localStorage.clear()
    localStorage.setItem('labeling-instructions-seen-q1', '1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob() }))
    global.URL.createObjectURL = vi.fn(() => 'blob:image')
  })

  /** Click `dx` screen px right of the tile centre. */
  function clickAt(dx: number) {
    const r = wrapper().getBoundingClientRect()
    fireEvent.click(wrapper(), { clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2 })
  }

  async function savedPoints() {
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    return saveTaskPoints.mock.calls.at(-1)![1] as { x: number; y: number }[]
  }

  it('refuses a second point placed on top of an existing one', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    markContainer()
    clickAt(0)
    clickAt(1) // inside the hit radius — grabs the existing dot instead of adding
    expect(await savedPoints()).toHaveLength(1)
  })

  it('lets a smaller dot size place points closer together', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    markContainer()

    // 5 screen px apart is inside 'L' (hit radius 9) but outside 'XS' (radius 3).
    fireEvent.click(screen.getByText('L'))
    clickAt(0)
    clickAt(5)
    expect(await savedPoints()).toHaveLength(1)

    fireEvent.click(screen.getByText('Clear'))
    fireEvent.click(screen.getByText('XS'))
    clickAt(0)
    clickAt(5)
    expect(await savedPoints()).toHaveLength(2)
  })

  it('zooming in lets fish be labelled closer together in source pixels', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    markContainer()
    fireEvent.click(screen.getByText('M')) // hit radius 6 screen px

    // At 100%, two clicks 5 source px apart collapse to one point.
    clickAt(0)
    clickAt(5)
    expect(await savedPoints()).toHaveLength(1)

    // Zoom to 8×, where those same 5 source px are 40 screen px apart.
    fireEvent.click(screen.getByText('Clear'))
    for (let i = 0; i < 10; i++) fireEvent.click(screen.getByTitle(/zoom in/i))
    clickAt(0)
    clickAt(40)
    const pts = await savedPoints()
    expect(pts).toHaveLength(2)
    // The pair really is ~5 source px apart — tighter than the 6 px floor at 100%.
    expect(Math.abs(pts[1].x - pts[0].x)).toBeLessThan(6)
  })

  it('remembers the dot size across tasks', async () => {
    const { unmount } = await act(async () => render(<QueueAnnotator {...baseProps()} />))
    fireEvent.click(screen.getByText('XS'))
    expect(localStorage.getItem('labeling-point-size')).toBe('xs')
    unmount()

    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    expect(screen.getByText('XS').className).toContain('bg-blue-600')
  })

  it('keeps dots a constant size on screen as the image zooms', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    markContainer()
    clickAt(0)

    const dot = () => document.querySelector('circle[fill="#ef4444"]')!
    const drawnRadius = () => parseFloat(dot().getAttribute('r')!)
    const atRest = drawnRadius()

    // Drawn in screen space, so the radius is a true screen-pixel value that does
    // not change with zoom — no sub-pixel geometry to go soft at high zoom.
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByTitle(/zoom in/i))
    expect(drawnRadius()).toBe(atRest)
    expect(atRest).toBeGreaterThanOrEqual(1.5)
  })

  it('keeps the overlay registered with the image through zoom and pan', async () => {
    await act(async () => { render(<QueueAnnotator {...baseProps()} />) })
    markContainer()

    // A point at the tile centre starts at the viewport centre.
    clickAt(0)
    const dotCentre = () => {
      const c = document.querySelector('circle[fill="#ef4444"]')!
      return { x: parseFloat(c.getAttribute('cx')!), y: parseFloat(c.getAttribute('cy')!) }
    }
    expect(dotCentre().x).toBeCloseTo(CONTAINER.w / 2, 4)

    // Centre-anchored zoom holds the tile centre still, so the dot must not move.
    fireEvent.click(screen.getByTitle(/zoom in/i))
    expect(dotCentre().x).toBeCloseTo(CONTAINER.w / 2, 4)
    expect(dotCentre().y).toBeCloseTo(CONTAINER.h / 2, 4)

    // Panning the image must carry the dot with it, one-for-one. Grab well clear
    // of the dot, or the drag moves the point instead of the image.
    const before = dotCentre()
    fireEvent.mouseDown(wrapper(), { clientX: 300, clientY: 250, button: 0 })
    fireEvent.mouseMove(window, { clientX: 360, clientY: 280 })
    fireEvent.mouseUp(window)
    expect(dotCentre().x).toBeCloseTo(before.x + 60, 4)
    expect(dotCentre().y).toBeCloseTo(before.y + 30, 4)
  })
})
