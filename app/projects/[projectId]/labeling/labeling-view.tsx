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
} from 'lucide-react'
import {
  createLabelingQueue,
  assignTasksToQueue,
  removeTasksFromQueue,
  deleteLabelingQueue,
  updateQueueAssignment,
  renameLabelingQueue,
} from '@/app/actions/labeling-queues'
import { deleteLabelingTasks } from '@/app/actions/labeling-tasks'

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

export default function LabelingView({ projectId, tasks: initialTasks, queues: initialQueues, users, canWrite }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // ── Local state ──────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState<TaskRow[]>(initialTasks)
  const [queues, setQueues] = useState<QueueRow[]>(initialQueues)

  const [taskFilter, setTaskFilter] = useState<TaskFilter>('incomplete')
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('__unassigned')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // ── Dialog state ─────────────────────────────────────────────────────────
  const [createQueueOpen, setCreateQueueOpen] = useState(false)
  const [newQueueName, setNewQueueName] = useState('')
  const [newQueueAssignee, setNewQueueAssignee] = useState<string>('')
  const [createQueueBusy, setCreateQueueBusy] = useState(false)

  const [assignQueueOpen, setAssignQueueOpen] = useState(false)
  const [assignTargetQueueId, setAssignTargetQueueId] = useState<string>('')

  const [deleteTasksOpen, setDeleteTasksOpen] = useState(false)
  const [deleteTasksBusy, setDeleteTasksBusy] = useState(false)

  const [editQueueId, setEditQueueId] = useState<string | null>(null)
  const [editQueueName, setEditQueueName] = useState('')
  const [editQueueAssignee, setEditQueueAssignee] = useState<string>('')
  const [editQueueBusy, setEditQueueBusy] = useState(false)

  const [deleteQueueId, setDeleteQueueId] = useState<string | null>(null)
  const [deleteQueueBusy, setDeleteQueueBusy] = useState(false)

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
    return result
  }, [tasks, queueFilter, taskFilter])

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

  const handleCreateQueue = useCallback(async () => {
    if (!newQueueName.trim()) return
    setCreateQueueBusy(true)
    const selectedIds = Array.from(selected)
    const res = await createLabelingQueue(
      projectId,
      newQueueName.trim(),
      newQueueAssignee || null,
      selectedIds,
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
      if (selectedIds.length > 0) {
        setTasks(prev => prev.map(t =>
          selectedIds.includes(t.taskId) ? { ...t, queueId: res.id! } : t
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
  }, [newQueueName, newQueueAssignee, selected, projectId, router])

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
    const res = await deleteLabelingQueue(deleteQueueId)
    if (res.ok) {
      setQueues(prev => prev.filter(q => q.id !== deleteQueueId))
      setTasks(prev => prev.map(t =>
        t.queueId === deleteQueueId ? { ...t, queueId: null } : t
      ))
      if (queueFilter === deleteQueueId) setQueueFilter('__unassigned')
    }
    setDeleteQueueBusy(false)
    setDeleteQueueId(null)
    startTransition(() => router.refresh())
  }, [deleteQueueId, queueFilter, router])

  // ── Tab counts ────────────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const base = queueFilter === '__unassigned'
      ? tasks.filter(t => !t.queueId)
      : tasks.filter(t => t.queueId === queueFilter)
    return {
      incomplete: base.filter(t => !t.completedBy).length,
      complete: base.filter(t => !!t.completedBy).length,
      all: base.length,
    }
  }, [tasks, queueFilter])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex gap-6 min-h-0">
      {/* ── Left Sidebar: Queue Panel ────────────────────────────────────── */}
      <aside className="w-60 shrink-0 flex flex-col gap-1">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Queues</h2>
          {canWrite && (
            <button
              onClick={() => setCreateQueueOpen(true)}
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
              title="Create queue"
            >
              <PlusIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Not in a queue */}
        <SidebarItem
          active={queueFilter === '__unassigned'}
          onClick={() => setQueueFilter('__unassigned')}
          icon={<InboxIcon className="w-3.5 h-3.5" />}
          label="Not in a queue"
          count={unassignedCount}
          countColor={unassignedCount > 0 ? 'text-amber-600 bg-amber-50' : undefined}
        />

        {queues.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-100 flex flex-col gap-1.5">
            {queues.map(q => {
              const assignee = q.assignedTo ? userById.get(q.assignedTo) : null
              const qCount = taskCountByQueueId.get(q.id) ?? 0
              const firstTaskId = firstIncompleteByQueueId.get(q.id)
              return (
                <div
                  key={q.id}
                  className={cn(
                    'group rounded-xl border transition-colors overflow-hidden',
                    queueFilter === q.id
                      ? 'border-blue-200 bg-blue-50'
                      : 'border-gray-100 bg-white hover:border-gray-200',
                  )}
                >
                  {/* Queue header — click to filter */}
                  <div
                    className="flex items-start justify-between gap-1 px-3 py-2.5 cursor-pointer"
                    onClick={() => setQueueFilter(q.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className={cn(
                        'text-xs font-semibold truncate leading-snug',
                        queueFilter === q.id ? 'text-blue-700' : 'text-gray-800',
                      )}>{q.name}</p>
                      {assignee && (
                        <p className="text-[10px] text-gray-400 flex items-center gap-0.5 mt-0.5 truncate">
                          <UserIcon className="w-2.5 h-2.5 shrink-0" />
                          {assignee.email}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 mt-0.5">
                      <span className={cn(
                        'text-[10px] rounded-full px-1.5 py-0.5 font-medium',
                        queueFilter === q.id ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500',
                      )}>
                        {qCount}
                      </span>
                      {canWrite && (
                        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              setEditQueueId(q.id)
                              setEditQueueName(q.name)
                              setEditQueueAssignee(q.assignedTo ?? '')
                            }}
                            className="p-0.5 rounded hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                            title="Edit queue"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setDeleteQueueId(q.id) }}
                            className="p-0.5 rounded hover:bg-red-100 text-gray-400 hover:text-red-600"
                            title="Delete queue"
                          >
                            <Trash2Icon className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Start Labeling button */}
                  {firstTaskId ? (
                    <Link
                      href={`/projects/${projectId}/labeling/${firstTaskId}`}
                      onClick={e => e.stopPropagation()}
                      className={cn(
                        'flex items-center justify-center gap-1.5 w-full px-3 py-2 text-xs font-semibold transition-colors border-t',
                        queueFilter === q.id
                          ? 'bg-blue-600 hover:bg-blue-700 text-white border-blue-500'
                          : 'bg-gray-50 hover:bg-blue-600 hover:text-white text-gray-500 border-gray-100 group-hover:bg-blue-600 group-hover:text-white group-hover:border-blue-500',
                      )}
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
                      Start Labeling
                    </Link>
                  ) : (
                    <div className="flex items-center justify-center w-full px-3 py-1.5 text-[10px] text-gray-300 border-t border-gray-100">
                      All complete
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </aside>

      {/* ── Right Panel: Tasks ───────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Header row */}
        {(() => {
          const activeQueue = typeof queueFilter === 'string' && queueFilter !== '__all' && queueFilter !== '__unassigned'
            ? queues.find(q => q.id === queueFilter)
            : null
          const firstTaskId = activeQueue ? firstIncompleteByQueueId.get(activeQueue.id) : null
          const assignee = activeQueue?.assignedTo ? userById.get(activeQueue.assignedTo) : null

          if (activeQueue) {
            return (
              <div className="flex items-center justify-between gap-4 bg-gradient-to-r from-blue-600 to-blue-500 rounded-2xl px-6 py-5 text-white">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-200 mb-0.5">Active Queue</p>
                  <h1 className="text-xl font-bold truncate">{activeQueue.name}</h1>
                  <p className="text-sm text-blue-200 mt-0.5">
                    {tabCounts.incomplete} incomplete · {tabCounts.complete} done · {tabCounts.all} total
                    {assignee && <span className="ml-2">· <UserIcon className="inline w-3 h-3 mb-0.5" /> {assignee.email}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canWrite && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCreateQueueOpen(true)}
                      className="bg-white/10 border-white/30 text-white hover:bg-white/20 hover:text-white gap-1.5"
                    >
                      <PlusIcon className="w-3.5 h-3.5" /> New Queue
                    </Button>
                  )}
                  {firstTaskId ? (
                    <Link
                      href={`/projects/${projectId}/labeling/queue/${activeQueue.id}`}
                      className="inline-flex items-center gap-2 rounded-xl bg-white text-blue-600 font-bold text-sm px-5 py-2.5 hover:bg-blue-50 transition-colors shadow-sm"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
                      Start Labeling
                    </Link>
                  ) : (
                    <div className="inline-flex items-center gap-2 rounded-xl bg-white/20 text-white/70 font-semibold text-sm px-5 py-2.5">
                      ✓ All complete
                    </div>
                  )}
                </div>
              </div>
            )
          }

          return (
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
          )
        })()}

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
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Flight plan</th>
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
                          <input type="checkbox" className="rounded pointer-events-none" checked={selected.has(task.taskId)} onChange={() => {}} />
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
            {selected.size > 0 && (
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
          <p className="text-sm text-gray-600 mt-1">
            The queue will be deleted. Tasks in this queue will <strong>not</strong> be deleted — they will simply become unassigned.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteQueueId(null)}>Cancel</Button>
            <Button
              onClick={handleDeleteQueue}
              disabled={deleteQueueBusy}
              className="bg-red-600 hover:bg-red-700 text-white border-red-600"
            >
              {deleteQueueBusy ? 'Deleting…' : 'Delete queue'}
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
