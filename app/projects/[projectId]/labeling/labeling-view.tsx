'use client'

import { useState, useCallback, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Trash2Icon,
  PlusIcon,
  InboxIcon,
  LayersIcon,
  UserIcon,
  XIcon,
  GridIcon,
} from 'lucide-react'
import {
  createLabelingQueue,
  assignTasksToQueue,
  removeTasksFromQueue,
  deleteLabelingQueue,
  updateQueueAssignment,
  renameLabelingQueue,
} from '@/app/actions/labeling-queues'
import { deleteLabelingTasks, splitLabelingTasksIntoTiles } from '@/app/actions/labeling-tasks'
import type { SurveyType } from '@/lib/schema'
import { DEFAULT_TILE_SIZE, TILE_SIZE_OPTIONS, countTiles } from '@/lib/tiling'

// ─── Types ───────────────────────────────────────────────────────────────────

type TaskRow = {
  taskId: string
  fileId: string
  fileKey: string
  x1: number
  y1: number
  x2: number
  y2: number
  frame: number
  completedBy: string | null
  queueId: string | null
  flightPlanName: string
  surveyType: SurveyType
  pointCount: number
  createdAtIso: string
}

type QueueRow = {
  id: string
  name: string
  projectId: string
  assignedTo: string | null
  createdBy: string
  createdAtIso: string
}

type UserRow = {
  id: string
  email: string
}

interface Props {
  projectId: string
  tasks: TaskRow[]
  queues: QueueRow[]
  users: UserRow[]
  canWrite: boolean
  fishLeaderboard?: { userId: string; count: number }[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type TaskFilter = 'incomplete' | 'complete' | 'all'
type QueueFilter = '__all' | '__unassigned' | string  // queue id

const TASK_TABS: { key: TaskFilter; label: string }[] = [
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'complete', label: 'Complete' },
  { key: 'all', label: 'All' },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function LabelingView({ projectId, tasks: initialTasks, queues: initialQueues, users, canWrite, fishLeaderboard = [] }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // ── Local state ──────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState<TaskRow[]>(initialTasks)
  const [queues, setQueues] = useState<QueueRow[]>(initialQueues)

  const [taskFilter, setTaskFilter] = useState<TaskFilter>('incomplete')
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('__unassigned')
  const [surveyTypeFilter, setSurveyTypeFilter] = useState<'all' | SurveyType>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // ── Dialog state ─────────────────────────────────────────────────────────
  const [createQueueOpen, setCreateQueueOpen] = useState(false)
  const [newQueueName, setNewQueueName] = useState('')
  const [newQueueAssignee, setNewQueueAssignee] = useState<string>('')
  const [addUnassignedToQueue, setAddUnassignedToQueue] = useState(true)
  const [createQueueBusy, setCreateQueueBusy] = useState(false)

  const [assignQueueOpen, setAssignQueueOpen] = useState(false)
  const [assignTargetQueueId, setAssignTargetQueueId] = useState<string>('')

  const [deleteTasksOpen, setDeleteTasksOpen] = useState(false)
  const [deleteTasksBusy, setDeleteTasksBusy] = useState(false)

  const [splitTasksOpen, setSplitTasksOpen] = useState(false)
  const [splitTasksBusy, setSplitTasksBusy] = useState(false)
  const [splitTileSize, setSplitTileSize] = useState<number>(DEFAULT_TILE_SIZE)

  const [editQueueId, setEditQueueId] = useState<string | null>(null)
  const [editQueueName, setEditQueueName] = useState('')
  const [editQueueAssignee, setEditQueueAssignee] = useState<string>('')
  const [editQueueBusy, setEditQueueBusy] = useState(false)

  const [deleteQueueId, setDeleteQueueId] = useState<string | null>(null)
  const [deleteQueueBusy, setDeleteQueueBusy] = useState(false)
  const [deleteQueueWithTasks, setDeleteQueueWithTasks] = useState(true)

  // ── Derived ───────────────────────────────────────────────────────────────
  const userById = useMemo(() => new Map(users.map(u => [u.id, u])), [users])
  const taskCountByQueueId = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tasks) {
      if (t.queueId) m.set(t.queueId, (m.get(t.queueId) ?? 0) + 1)
    }
    return m
  }, [tasks])

  // First incomplete task per queue, for the "Start Labeling" shortcut
  const firstIncompleteByQueueId = useMemo(() => {
    const m = new Map<string, string>() // queueId → taskId
    for (const t of tasks) {
      if (t.queueId && !t.completedBy && !m.has(t.queueId)) {
        m.set(t.queueId, t.taskId)
      }
    }
    return m
  }, [tasks])

  const filteredTasks = useMemo(() => {
    let result = tasks
    if (queueFilter === '__unassigned') {
      result = result.filter(t => !t.queueId)
    } else {
      result = result.filter(t => t.queueId === queueFilter)
    }
    if (taskFilter === 'incomplete') result = result.filter(t => !t.completedBy)
    else if (taskFilter === 'complete') result = result.filter(t => !!t.completedBy)
    if (surveyTypeFilter !== 'all') result = result.filter(t => t.surveyType === surveyTypeFilter)
    return result
  }, [tasks, queueFilter, taskFilter, surveyTypeFilter])

  const allFilteredSelected = filteredTasks.length > 0 && filteredTasks.every(t => selected.has(t.taskId))
  const someFilteredSelected = filteredTasks.some(t => selected.has(t.taskId))

  const selectedInView = filteredTasks.filter(t => selected.has(t.taskId))
  const totalCount = tasks.length
  const incompleteCount = tasks.filter(t => !t.completedBy).length
  const unassignedCount = tasks.filter(t => !t.queueId).length

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleDeleteTasks = useCallback(async () => {
    if (selectedInView.length === 0) return
    setDeleteTasksBusy(true)
    const ids = selectedInView.map(t => t.taskId)
    const res = await deleteLabelingTasks(ids)
    if (res.ok) {
      setTasks(prev => prev.filter(t => !ids.includes(t.taskId)))
      setSelected(new Set())
    }
    setDeleteTasksBusy(false)
    setDeleteTasksOpen(false)
    startTransition(() => router.refresh())
  }, [selectedInView, router])

  // Tasks in the selection that a re-tile would actually change — image tasks
  // (non-zero crop) whose region is big enough to come apart into 2+ tiles.
  const splittableSelected = useMemo(
    () => selectedInView.filter(t =>
      t.x2 - t.x1 > 0 && t.y2 - t.y1 > 0 &&
      countTiles(t.x1, t.y1, t.x2, t.y2, splitTileSize) > 1
    ),
    [selectedInView, splitTileSize],
  )
  const splitResultCount = useMemo(
    () => splittableSelected.reduce(
      (sum, t) => sum + countTiles(t.x1, t.y1, t.x2, t.y2, splitTileSize), 0,
    ),
    [splittableSelected, splitTileSize],
  )

  const handleSplitTasks = useCallback(async () => {
    if (splittableSelected.length === 0) return
    setSplitTasksBusy(true)
    const res = await splitLabelingTasksIntoTiles(
      splittableSelected.map(t => t.taskId),
      splitTileSize,
    )
    setSplitTasksBusy(false)
    if (res.ok && res.groups) {
      // Swap each source row for its tiles in place — everything but the crop,
      // the id and the point count is inherited from the task being replaced.
      const byId = new Map(tasks.map(t => [t.taskId, t]))
      const replacements = new Map(res.groups.map(g => [g.sourceTaskId, g.tiles]))
      setTasks(prev => prev.flatMap(t => {
        const tiles = replacements.get(t.taskId)
        if (!tiles) return [t]
        const source = byId.get(t.taskId)!
        return tiles.map(tile => ({
          ...source,
          taskId: tile.taskId,
          x1: tile.x1,
          y1: tile.y1,
          x2: tile.x2,
          y2: tile.y2,
          pointCount: tile.pointCount,
        }))
      }))
      setSelected(new Set())
      setSplitTasksOpen(false)
      startTransition(() => router.refresh())
    }
  }, [splittableSelected, splitTileSize, tasks, router])

  const handleCreateQueue = useCallback(async () => {
    if (!newQueueName.trim()) return
    setCreateQueueBusy(true)
    // If addUnassignedToQueue is checked, include all unassigned tasks that match
    // the active survey-type filter; otherwise fall back to whatever is manually
    // selected in the table (selection is itself drawn from filteredTasks).
    const unassignedIds = tasks
      .filter(t => !t.queueId && (surveyTypeFilter === 'all' || t.surveyType === surveyTypeFilter))
      .map(t => t.taskId)
    const taskIds = addUnassignedToQueue && unassignedIds.length > 0
      ? unassignedIds
      : Array.from(selected)
    const res = await createLabelingQueue(
      projectId,
      newQueueName.trim(),
      newQueueAssignee || null,
      taskIds,
    )
    if (res.ok && res.id) {
      const newQueue: QueueRow = {
        id: res.id,
        name: newQueueName.trim(),
        projectId,
        assignedTo: newQueueAssignee || null,
        createdBy: '',
        createdAtIso: new Date().toISOString(),
      }
      setQueues(prev => [newQueue, ...prev])
      if (taskIds.length > 0) {
        setTasks(prev => prev.map(t =>
          taskIds.includes(t.taskId) ? { ...t, queueId: res.id! } : t
        ))
        setSelected(new Set())
      }
      setQueueFilter(res.id)
    }
    setCreateQueueBusy(false)
    setCreateQueueOpen(false)
    setNewQueueName('')
    setNewQueueAssignee('')
    startTransition(() => router.refresh())
  }, [newQueueName, newQueueAssignee, addUnassignedToQueue, tasks, selected, surveyTypeFilter, projectId, router])

  const handleAssignToQueue = useCallback(async () => {
    if (!assignTargetQueueId) return
    const ids = selectedInView.map(t => t.taskId)
    const res = await assignTasksToQueue(assignTargetQueueId, ids)
    if (res.ok) {
      setTasks(prev => prev.map(t =>
        ids.includes(t.taskId) ? { ...t, queueId: assignTargetQueueId } : t
      ))
      setSelected(new Set())
    }
    setAssignQueueOpen(false)
    setAssignTargetQueueId('')
    startTransition(() => router.refresh())
  }, [assignTargetQueueId, selectedInView, router])

  const handleRemoveFromQueue = useCallback(async () => {
    const ids = selectedInView.map(t => t.taskId)
    const res = await removeTasksFromQueue(ids)
    if (res.ok) {
      setTasks(prev => prev.map(t =>
        ids.includes(t.taskId) ? { ...t, queueId: null } : t
      ))
      setSelected(new Set())
    }
    startTransition(() => router.refresh())
  }, [selectedInView, router])

  const handleSaveQueueEdit = useCallback(async () => {
    if (!editQueueId) return
    setEditQueueBusy(true)
    await Promise.all([
      renameLabelingQueue(editQueueId, editQueueName.trim()),
      updateQueueAssignment(editQueueId, editQueueAssignee || null),
    ])
    setQueues(prev => prev.map(q =>
      q.id === editQueueId
        ? { ...q, name: editQueueName.trim(), assignedTo: editQueueAssignee || null }
        : q
    ))
    setEditQueueBusy(false)
    setEditQueueId(null)
    startTransition(() => router.refresh())
  }, [editQueueId, editQueueName, editQueueAssignee, router])

  const handleDeleteQueue = useCallback(async () => {
    if (!deleteQueueId) return
    setDeleteQueueBusy(true)
    const res = await deleteLabelingQueue(deleteQueueId, deleteQueueWithTasks)
    if (res.ok) {
      setQueues(prev => prev.filter(q => q.id !== deleteQueueId))
      if (deleteQueueWithTasks) {
        setTasks(prev => prev.filter(t => t.queueId !== deleteQueueId))
      } else {
        setTasks(prev => prev.map(t =>
          t.queueId === deleteQueueId ? { ...t, queueId: null } : t
        ))
      }
      if (queueFilter === deleteQueueId) setQueueFilter('__unassigned')
    }
    setDeleteQueueBusy(false)
    setDeleteQueueId(null)
    startTransition(() => router.refresh())
  }, [deleteQueueId, deleteQueueWithTasks, queueFilter, router])

  // ── Tab counts ────────────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    let base = queueFilter === '__unassigned'
      ? tasks.filter(t => !t.queueId)
      : tasks.filter(t => t.queueId === queueFilter)
    if (surveyTypeFilter !== 'all') base = base.filter(t => t.surveyType === surveyTypeFilter)
    return {
      incomplete: base.filter(t => !t.completedBy).length,
      complete: base.filter(t => !!t.completedBy).length,
      all: base.length,
    }
  }, [tasks, queueFilter, surveyTypeFilter])

  // ── Derived: queues split by completion ──────────────────────────────────
  const { incompleteQueues, completeQueues } = useMemo(() => {
    const incomplete: QueueRow[] = []
    const complete: QueueRow[] = []
    for (const q of queues) {
      if (firstIncompleteByQueueId.has(q.id)) incomplete.push(q)
      else complete.push(q)
    }
    return { incompleteQueues: incomplete, completeQueues: complete }
  }, [queues, firstIncompleteByQueueId])

  const leaderboard = useMemo(() => {
    const counts: Record<string, { email: string; count: number }> = {}
    users.forEach(u => {
      counts[u.id] = { email: u.email, count: 0 }
    })
    tasks.forEach(t => {
      if (t.completedBy && counts[t.completedBy]) {
        counts[t.completedBy].count += 1
      }
    })
    return Object.values(counts)
      .filter(item => item.count > 0)
      .sort((a, b) => b.count - a.count)
  }, [tasks, users])

  const processedFishLeaderboard = useMemo(() => {
    const userMap = new Map(users.map(u => [u.id, u.email]))
    return fishLeaderboard
      .map(item => ({
        email: userMap.get(item.userId) ?? 'Unknown',
        count: item.count,
      }))
      .filter(item => item.count > 0)
      .sort((a, b) => b.count - a.count)
  }, [fishLeaderboard, users])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-8">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Labeling</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {incompleteCount} task{incompleteCount !== 1 ? 's' : ''} remaining of {totalCount} total
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setCreateQueueOpen(true)} size="sm" className="gap-1.5 shrink-0">
            <PlusIcon className="w-3.5 h-3.5" /> New Queue
          </Button>
        )}
      </div>

      {/* ── Leaderboards ──────────────────────────────────────────────────── */}
      {(leaderboard.length > 0 || processedFishLeaderboard.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Leaderboard (Images) - Span 2 */}
          {leaderboard.length > 0 && (
            <div className="lg:col-span-2 bg-white border border-gray-200 rounded-2xl p-5 text-gray-900 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-3">
                  <div>
                    <h2 className="text-sm font-bold tracking-wide uppercase text-blue-600">Labeling Leaderboard</h2>
                    <p className="text-[11px] text-gray-505 mt-0.5">Top contributors by completed image/frame tasks</p>
                  </div>
                  <span className="text-xs bg-blue-55 text-blue-700 px-2.5 py-1 rounded-full font-semibold border border-blue-200">
                    🏆 {leaderboard.reduce((acc, u) => acc + u.count, 0)} Images
                  </span>
                </div>

                <div className="divide-y divide-gray-100">
                  {leaderboard.map((item, idx) => {
                    const rankColor =
                      idx === 0 ? 'bg-amber-100 text-amber-800 border-amber-200' :
                        idx === 1 ? 'bg-slate-100 text-slate-800 border-slate-200' :
                          idx === 2 ? 'bg-orange-100 text-orange-800 border-orange-200' :
                            'bg-gray-100 text-gray-600 border-gray-200'

                    const rankBadge =
                      idx === 0 ? '🥇' :
                        idx === 1 ? '🥈' :
                          idx === 2 ? '🥉' :
                            `#${idx + 1}`

                    return (
                      <div
                        key={item.email}
                        className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={cn(
                            "flex items-center justify-center w-6 h-6 rounded-lg text-xs font-black shrink-0 border",
                            rankColor
                          )}>
                            {rankBadge}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900 truncate" title={item.email}>
                              {item.email.split('@')[0]}
                            </p>
                            <p className="text-xs text-gray-500 truncate">{item.email}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0 font-bold tabular-nums text-blue-600">
                          {item.count} <span className="text-[11px] text-gray-550 font-normal">images</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Side Leaderboard (Fish) - Span 1 */}
          {processedFishLeaderboard.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-2xl p-5 text-gray-900 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-3">
                  <div>
                    <h2 className="text-sm font-bold tracking-wide uppercase text-teal-600">Total Fish Leaderboard</h2>
                    <p className="text-[11px] text-gray-505 mt-0.5">Total fish counted across tasks & maps</p>
                  </div>
                  <span className="text-xs bg-teal-50 text-teal-700 px-2 py-0.5 rounded border border-teal-200 font-semibold shrink-0">
                    🐟 {processedFishLeaderboard.reduce((acc, u) => acc + u.count, 0)} Fish
                  </span>
                </div>

                <div className="divide-y divide-gray-100">
                  {processedFishLeaderboard.slice(0, 5).map((item, idx) => {
                    const rankColor =
                      idx === 0 ? 'bg-amber-100 text-amber-800 border-amber-200' :
                        idx === 1 ? 'bg-slate-100 text-slate-800 border-slate-200' :
                          idx === 2 ? 'bg-orange-100 text-orange-800 border-orange-200' :
                            'bg-gray-100 text-gray-600 border-gray-200'

                    const rankBadge =
                      idx === 0 ? '🥇' :
                        idx === 1 ? '🥈' :
                          idx === 2 ? '🥉' :
                            `#${idx + 1}`

                    return (
                      <div
                        key={item.email}
                        className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={cn(
                            "flex items-center justify-center w-6 h-6 rounded-lg text-xs font-black shrink-0 border",
                            rankColor
                          )}>
                            {rankBadge}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900 truncate" title={item.email}>
                              {item.email.split('@')[0]}
                            </p>
                            <p className="text-xs text-gray-500 truncate">{item.email}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0 font-bold tabular-nums text-teal-600">
                          {item.count} <span className="text-[11px] text-gray-505 font-normal">fish</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Incomplete queues (hero) ──────────────────────────────────────── */}
      {incompleteQueues.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">In progress</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {incompleteQueues.map(q => {
              const assignee = q.assignedTo ? userById.get(q.assignedTo) : null
              const total = taskCountByQueueId.get(q.id) ?? 0
              const incomplete = tasks.filter(t => t.queueId === q.id && !t.completedBy).length
              const done = total - incomplete
              const pct = total > 0 ? Math.round((done / total) * 100) : 0
              const firstTaskId = firstIncompleteByQueueId.get(q.id)
              return (
                <div key={q.id} className="group bg-white rounded-2xl border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all overflow-hidden flex flex-col">
                  <div className="px-5 pt-5 pb-4 flex-1">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <h3 className="text-base font-bold text-gray-900 leading-snug">{q.name}</h3>
                      {canWrite && (
                        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity shrink-0">
                          <button
                            onClick={() => { setEditQueueId(q.id); setEditQueueName(q.name); setEditQueueAssignee(q.assignedTo ?? '') }}
                            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                            title="Edit queue"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                          </button>
                          <button
                            onClick={() => setDeleteQueueId(q.id)}
                            className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                            title="Delete queue"
                          >
                            <Trash2Icon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mb-3">
                      <UserIcon className="w-3 h-3 text-gray-400 shrink-0" />
                      <span className="text-xs text-gray-500">
                        {assignee ? assignee.email : <span className="italic text-gray-400">Unassigned</span>}
                      </span>
                      {canWrite && (
                        <button
                          onClick={() => { setEditQueueId(q.id); setEditQueueName(q.name); setEditQueueAssignee(q.assignedTo ?? '') }}
                          className="p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600 transition-colors"
                          title="Reassign"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-sm mb-1.5">
                      <span className="text-gray-500">{done} / {total} done</span>
                      <span className="font-semibold text-gray-700">{pct}%</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-xs text-amber-600 font-medium mt-2">{incomplete} remaining</p>
                  </div>
                  {firstTaskId ? (
                    <Link
                      href={`/projects/${projectId}/labeling/queue/${q.id}`}
                      className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold transition-colors"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
                      Start Labeling
                    </Link>
                  ) : null}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Complete queues ───────────────────────────────────────────────── */}
      {completeQueues.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Complete</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {completeQueues.map(q => {
              const assignee = q.assignedTo ? userById.get(q.assignedTo) : null
              const total = taskCountByQueueId.get(q.id) ?? 0
              return (
                <div key={q.id} className="group bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center justify-between gap-3 hover:border-gray-300 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-700 truncate">{q.name}</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      <UserIcon className="w-3 h-3 text-gray-400 shrink-0" />
                      <span className="text-xs text-gray-400 truncate">
                        {assignee ? assignee.email : <span className="italic">Unassigned</span>}
                      </span>
                      {canWrite && (
                        <button
                          onClick={() => { setEditQueueId(q.id); setEditQueueName(q.name); setEditQueueAssignee(q.assignedTo ?? '') }}
                          className="p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600 transition-colors shrink-0"
                          title="Reassign"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-green-600 font-medium mt-0.5">✓ {total} tasks done</p>
                  </div>
                  {canWrite && (
                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity shrink-0">
                      <button
                        onClick={() => { setEditQueueId(q.id); setEditQueueName(q.name); setEditQueueAssignee(q.assignedTo ?? '') }}
                        className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                        title="Edit"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      </button>
                      <button
                        onClick={() => setDeleteQueueId(q.id)}
                        className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                        title="Delete"
                      >
                        <Trash2Icon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── No queues yet ─────────────────────────────────────────────────── */}
      {queues.length === 0 && tasks.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-6 py-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-amber-800">{unassignedCount} unassigned task{unassignedCount !== 1 ? 's' : ''}</p>
            <p className="text-xs text-amber-600 mt-0.5">Create a queue to start labeling.</p>
          </div>
          {canWrite && (
            <Button onClick={() => setCreateQueueOpen(true)} size="sm" className="gap-1.5 shrink-0 bg-amber-600 hover:bg-amber-700 text-white border-0">
              <PlusIcon className="w-3.5 h-3.5" /> New Queue
            </Button>
          )}
        </div>
      )}

      {/* ── Task management (collapsible) ─────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Tasks
            {unassignedCount > 0 && (
              <span className="ml-2 text-[10px] bg-amber-50 text-amber-600 border border-amber-200 rounded-full px-1.5 py-0.5 font-medium normal-case tracking-normal">
                {unassignedCount} unassigned
              </span>
            )}
          </h2>
          {/* Queue filter pills */}
          <div className="flex items-center gap-1 flex-wrap">
            <button
              onClick={() => setQueueFilter('__unassigned')}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                queueFilter === '__unassigned' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
              )}
            >
              Unassigned
            </button>
            {queues.map(q => (
              <button
                key={q.id}
                onClick={() => setQueueFilter(q.id)}
                className={cn(
                  'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                  queueFilter === q.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                )}
              >
                {q.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {/* Status tabs + bulk bar */}

          {/* Status tabs */}
          <div className="flex items-center gap-1 border-b border-gray-200">
            {TASK_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setTaskFilter(tab.key)}
                className={cn(
                  'px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
                  taskFilter === tab.key
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-800',
                )}
              >
                {tab.label}
                <span className={cn(
                  'ml-1.5 rounded-full px-1.5 py-0.5 text-xs',
                  taskFilter === tab.key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500',
                )}>
                  {tabCounts[tab.key]}
                </span>
              </button>
            ))}
            {/* Survey type filter — e.g. scope queue creation to spawning-ground flights only */}
            <select
              value={surveyTypeFilter}
              onChange={e => setSurveyTypeFilter(e.target.value as 'all' | SurveyType)}
              className="ml-3 mb-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 cursor-pointer"
            >
              <option value="all">All survey types</option>
              <option value="migration">Migration only</option>
              <option value="spawning">Spawning only</option>
            </select>
          </div>

          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
              <span className="text-blue-700 font-medium">{selected.size} selected</span>
              <span className="text-blue-300 mx-1">·</span>
              {canWrite && (
                <>
                  <button
                    onClick={() => setAssignQueueOpen(true)}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    disabled={queues.length === 0}
                  >
                    Add to queue
                  </button>
                  {selectedInView.some(t => t.queueId) && (
                    <button
                      onClick={handleRemoveFromQueue}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    >
                      Remove from queue
                    </button>
                  )}
                  {selectedInView.some(t => t.x2 - t.x1 > 0 && t.y2 - t.y1 > 0) && (
                    <button
                      onClick={() => setSplitTasksOpen(true)}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    >
                      <GridIcon className="w-3.5 h-3.5 mr-1" />
                      Split into tiles…
                    </button>
                  )}
                  <button
                    onClick={() => setDeleteTasksOpen(true)}
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'sm' }),
                      'text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300 hover:text-red-700'
                    )}
                  >
                    <Trash2Icon className="w-3.5 h-3.5 mr-1" />
                    Delete
                  </button>
                </>
              )}
              <button
                onClick={() => setSelected(new Set())}
                className="ml-auto text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
              >
                <XIcon className="w-3.5 h-3.5" /> Clear
              </button>
            </div>
          )}

          {/* Task table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {filteredTasks.length === 0 ? (
              <p className="text-sm text-gray-500 p-6">No tasks.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {canWrite && (
                      <th className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={allFilteredSelected}
                          ref={el => { if (el) el.indeterminate = !allFilteredSelected && someFilteredSelected }}
                          onChange={e => {
                            if (e.target.checked) setSelected(prev => new Set([...prev, ...filteredTasks.map(t => t.taskId)]))
                            else setSelected(prev => {
                              const n = new Set(prev)
                              filteredTasks.forEach(t => n.delete(t.taskId))
                              return n
                            })
                          }}
                        />
                      </th>
                    )}
                    <th className="text-left px-4 py-3 font-medium text-gray-600">File</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Flight route</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Queue</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Points</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredTasks.map(task => {
                    const filename = task.fileKey.split('/').pop() ?? task.fileKey
                    const complete = !!task.completedBy
                    const queue = task.queueId ? queues.find(q => q.id === task.queueId) : null
                    return (
                      <tr key={task.taskId} className={cn('transition-colors', selected.has(task.taskId) ? 'bg-blue-50' : 'hover:bg-gray-50')}>
                        {canWrite && (
                          <td className="px-4 py-3" onClick={() => setSelected(prev => {
                            const n = new Set(prev)
                            n.has(task.taskId) ? n.delete(task.taskId) : n.add(task.taskId)
                            return n
                          })}>
                            <input type="checkbox" className="rounded pointer-events-none" checked={selected.has(task.taskId)} onChange={() => { }} />
                          </td>
                        )}
                        <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-[200px] truncate" title={filename}>
                          {filename}
                        </td>
                        <td className="px-4 py-3 text-gray-500">{task.flightPlanName}</td>
                        <td className="px-4 py-3">
                          {queue ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                              <LayersIcon className="w-3 h-3" />
                              {queue.name}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {task.pointCount > 0
                            ? <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{task.pointCount}</span>
                            : <span className="text-xs text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {complete
                            ? <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">Done</span>
                            : <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">Pending</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      {/* ── Create Queue Dialog ───────────────────────────────────────────── */}
      <Dialog open={createQueueOpen} onOpenChange={o => { if (!o) { setCreateQueueOpen(false); setNewQueueName(''); setNewQueueAssignee('') } }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Create labeling queue</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-1">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Queue name</label>
              <input
                autoFocus
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                placeholder="e.g. Batch 1 — Flight A"
                value={newQueueName}
                onChange={e => setNewQueueName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && newQueueName.trim()) handleCreateQueue() }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Assign to (optional)</label>
              <select
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                value={newQueueAssignee}
                onChange={e => setNewQueueAssignee(e.target.value)}
              >
                <option value="">— unassigned —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
              </select>
            </div>
            {unassignedCount > 0 && (
              <label className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-gray-200 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors">
                <input
                  type="checkbox"
                  className="rounded"
                  checked={addUnassignedToQueue}
                  onChange={e => setAddUnassignedToQueue(e.target.checked)}
                />
                <span className="text-sm text-gray-700">
                  Add all <span className="font-semibold">{unassignedCount}</span> unassigned task{unassignedCount !== 1 ? 's' : ''} to this queue
                </span>
              </label>
            )}
            {!addUnassignedToQueue && selected.size > 0 && (
              <p className="text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2">
                {selected.size} selected task{selected.size !== 1 ? 's' : ''} will be added to this queue.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateQueueOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateQueue} disabled={!newQueueName.trim() || createQueueBusy}>
              {createQueueBusy ? 'Creating…' : 'Create queue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Assign to Queue Dialog ────────────────────────────────────────── */}
      <Dialog open={assignQueueOpen} onOpenChange={o => { if (!o) setAssignQueueOpen(false) }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Add to queue</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-1">
            <p className="text-sm text-gray-600">
              Move <strong>{selectedInView.length}</strong> task{selectedInView.length !== 1 ? 's' : ''} into a queue.
            </p>
            <select
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              value={assignTargetQueueId}
              onChange={e => setAssignTargetQueueId(e.target.value)}
            >
              <option value="">Select a queue…</option>
              {queues.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignQueueOpen(false)}>Cancel</Button>
            <Button onClick={handleAssignToQueue} disabled={!assignTargetQueueId}>Add to queue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Queue Dialog ─────────────────────────────────────────────── */}
      <Dialog open={!!editQueueId} onOpenChange={o => { if (!o) setEditQueueId(null) }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Edit queue</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-1">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Queue name</label>
              <input
                autoFocus
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                value={editQueueName}
                onChange={e => setEditQueueName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Assigned to</label>
              <select
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                value={editQueueAssignee}
                onChange={e => setEditQueueAssignee(e.target.value)}
              >
                <option value="">— unassigned —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditQueueId(null)}>Cancel</Button>
            <Button onClick={handleSaveQueueEdit} disabled={!editQueueName.trim() || editQueueBusy}>
              {editQueueBusy ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Queue Confirm ──────────────────────────────────────────── */}
      <Dialog open={!!deleteQueueId} onOpenChange={o => { if (!o) setDeleteQueueId(null) }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Delete queue?</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-1">
            <p className="text-sm text-gray-600">
              {deleteQueueWithTasks
                ? <>The queue and all its labeling tasks will be <strong>permanently deleted</strong>.</>
                : <>The queue will be deleted. Its tasks will become <strong>unassigned</strong>.</>
              }
            </p>
            {(() => {
              const taskCount = deleteQueueId ? tasks.filter(t => t.queueId === deleteQueueId).length : 0
              return (
                <label className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-gray-200 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={deleteQueueWithTasks}
                    onChange={e => setDeleteQueueWithTasks(e.target.checked)}
                  />
                  <span className="text-sm text-gray-700">
                    Also delete the <span className="font-semibold">{taskCount}</span> labeling task{taskCount !== 1 ? 's' : ''} in this queue
                  </span>
                </label>
              )
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteQueueId(null)}>Cancel</Button>
            <Button
              onClick={handleDeleteQueue}
              disabled={deleteQueueBusy}
              className="bg-red-600 hover:bg-red-700 text-white border-red-600"
            >
              {deleteQueueBusy ? 'Deleting…' : deleteQueueWithTasks ? 'Delete queue & tasks' : 'Delete queue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Split Tasks Into Tiles ────────────────────────────────────────── */}
      <Dialog open={splitTasksOpen} onOpenChange={o => { if (!o) setSplitTasksOpen(false) }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Split tasks into tiles</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600 mt-1">
            Cuts each selected image task into a grid of smaller crops, so a labeler sees fewer
            fish at a time and the annotator can show each tile at full resolution. Tiles stay in
            the same queue, and existing annotations move to the tile they fall in.
          </p>
          <label className="flex items-center justify-between gap-3 text-sm mt-1">
            <span className="text-gray-700">Tile size</span>
            <select
              value={String(splitTileSize)}
              onChange={e => setSplitTileSize(Number(e.target.value))}
              className="rounded border border-gray-300 px-2 py-1 text-sm cursor-pointer"
            >
              {TILE_SIZE_OPTIONS.filter(o => o.value !== null).map(o => (
                <option key={o.label} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
          </label>
          <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-sm text-gray-700">
            <strong>{splittableSelected.length}</strong> of {selectedInView.length} selected task
            {selectedInView.length !== 1 ? 's' : ''} will be replaced by{' '}
            <strong>{splitResultCount}</strong> tile{splitResultCount !== 1 ? 's' : ''}.
            {splittableSelected.length < selectedInView.length && (
              <span className="block text-xs text-gray-500 mt-1">
                The rest are video tasks or already at or below this tile size, and are left as-is.
              </span>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSplitTasksOpen(false)}>Cancel</Button>
            <Button onClick={handleSplitTasks} disabled={splitTasksBusy || splittableSelected.length === 0}>
              {splitTasksBusy ? 'Splitting…' : `Split into ${splitResultCount} tile${splitResultCount !== 1 ? 's' : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Tasks Confirm ──────────────────────────────────────────── */}
      <Dialog open={deleteTasksOpen} onOpenChange={o => { if (!o) setDeleteTasksOpen(false) }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Delete {selectedInView.length} task{selectedInView.length !== 1 ? 's' : ''}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600 mt-1">
            This will permanently delete the selected labeling tasks and all their annotations. This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTasksOpen(false)}>Cancel</Button>
            <Button
              onClick={handleDeleteTasks}
              disabled={deleteTasksBusy}
              className="bg-red-600 hover:bg-red-700 text-white border-red-600"
            >
              {deleteTasksBusy ? 'Deleting…' : `Delete ${selectedInView.length} task${selectedInView.length !== 1 ? 's' : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Sidebar Item ─────────────────────────────────────────────────────────────

function SidebarItem({
  active,
  onClick,
  icon,
  label,
  count,
  countColor,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count: number
  countColor?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors text-left',
        active ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100',
      )}
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      <span className={cn(
        'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        active ? 'bg-blue-100 text-blue-700' : (countColor ?? 'bg-gray-100 text-gray-500'),
      )}>
        {count}
      </span>
    </button>
  )
}
