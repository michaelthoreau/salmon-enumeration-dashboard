'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, ChevronLeft, ChevronRight, Volume2, VolumeX, Loader2, Minus, Plus, Settings, NotebookPen, X, Trash2, Maximize2, ChevronDown, ChevronUp, History, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { updateFileDuration } from '@/app/actions/files'

interface VideoNote {
  id: string
  time: number
  frame: number
  text: string
  author?: string
}

interface VideoPlayerProps {
  videoUrl: string
  filename: string
  fishCount?: number
  canWrite?: boolean
  onIncrement?: () => void
  onDecrement?: () => void
  notes?: VideoNote[]
  onAddNote?: (note: { time: number; frame: number; text: string }) => void
  onDeleteNote?: (id: string) => void
  onExpand?: () => void
  fileId?: string
  existingDuration?: number | null
}

export default function VideoPlayer({
  videoUrl, filename, fishCount = 0, canWrite = false,
  onIncrement, onDecrement,
  notes = [], onAddNote, onDeleteNote, onExpand,
  fileId, existingDuration,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noteInputRef = useRef<HTMLInputElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isMuted, setIsMuted] = useState(true)
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [fps, setFps] = useState(29.97)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showControls, setShowControls] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showNotepad, setShowNotepad] = useState(false)
  const [noteInput, setNoteInput] = useState('')
  const [showAdvancedFps, setShowAdvancedFps] = useState(false)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState(0)
  const [showMidline, setShowMidline] = useState(true)
  const [showEscapement, setShowEscapement] = useState(false)
  const [fishSnapshots, setFishSnapshots] = useState<{ time: number; delta: number; total: number }[]>([])
  const [showFishTimeline, setShowFishTimeline] = useState(false)
  const [fishTimelinePopped, setFishTimelinePopped] = useState(false)
  const lastBucketRef = useRef(-1)
  const countAtBucketStartRef = useRef(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoUrl) return

    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleTimeUpdate = () => setCurrentTime(video.currentTime)
    const handleDurationChange = () => {
      setDuration(video.duration)
      if (fileId && video.duration > 0 && !existingDuration) {
        updateFileDuration(fileId, video.duration).catch(() => {})
      }
    }
    const handleWaiting = () => setIsLoading(true)
    const handlePlaying = () => setIsLoading(false)
    const handleCanPlay = () => setIsLoading(false)
    const handleRateChange = () => setPlaybackRate(video.playbackRate)
    const handleSeeked = () => {
      setCurrentTime(video.currentTime)
      setIsLoading(false)
    }

    const handleProgress = () => {
      const ranges: { start: number; end: number }[] = []
      for (let i = 0; i < video.buffered.length; i++) {
        ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) })
      }
      setBufferedRanges(ranges)
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('durationchange', handleDurationChange)
    video.addEventListener('progress', handleProgress)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('playing', handlePlaying)
    video.addEventListener('canplay', handleCanPlay)
    video.addEventListener('ratechange', handleRateChange)
    video.addEventListener('seeking', handleWaiting)
    video.addEventListener('seeked', handleSeeked)

    setIsLoading(true)
    video.load()
    video.playbackRate = playbackRate

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('durationchange', handleDurationChange)
      video.removeEventListener('progress', handleProgress)
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('canplay', handleCanPlay)
      video.removeEventListener('ratechange', handleRateChange)
      video.removeEventListener('seeking', handleWaiting)
      video.removeEventListener('seeked', handleSeeked)
    }
  }, [videoUrl])

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = playbackRate
  }, [playbackRate])

  const resetHideTimer = useCallback(() => {
    setShowControls(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    if (isPlaying) {
      hideTimerRef.current = setTimeout(() => setShowControls(false), 2500)
    }
  }, [isPlaying])

  useEffect(() => {
    if (!isPlaying) {
      setShowControls(true)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    } else {
      resetHideTimer()
    }
  }, [isPlaying, resetHideTimer])

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  // Hotkeys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          stepFrame('prev')
          break
        case 'ArrowRight':
          e.preventDefault()
          stepFrame('next')
          break
        case 'm':
        case 'M':
          e.preventDefault()
          toggleMute()
          break
        case 'f':
        case 'F':
          if (canWrite) { e.preventDefault(); onIncrement?.() }
          break
        case 'd':
        case 'D':
          if (canWrite) { e.preventDefault(); onDecrement?.() }
          break
        case 'n':
        case 'N':
          if (canWrite) { e.preventDefault(); setShowNotepad(p => !p) }
          break
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [canWrite, onIncrement, onDecrement, isPlaying, isMuted, fps, duration])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }

  const toggleMute = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !isMuted
    setIsMuted(!isMuted)
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current
    if (!video || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    video.currentTime = pct * duration
    setCurrentTime(pct * duration)
  }

  const handleSeekHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setHoverTime(pct * duration)
    setHoverX(e.clientX - rect.left)
  }

  const stepFrame = (direction: 'prev' | 'next') => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    const frameTime = 1 / fps
    let targetTime = video.currentTime + (direction === 'next' ? frameTime : -frameTime)
    if (targetTime < 0) targetTime = 0
    if (targetTime > duration) targetTime = duration
    video.currentTime = targetTime
    setCurrentTime(targetTime)
  }

  const handleAddNote = () => {
    const text = noteInput.trim()
    if (!text || !onAddNote) return
    onAddNote({ time: currentTime, frame: currentFrame, text })
    setNoteInput('')
    noteInputRef.current?.focus()
  }

  // Initialize fish timeline from persisted __ft__ notes on mount
  useEffect(() => {
    const existing = notes
      .filter((n) => n.text.startsWith('__ft__:'))
      .map((n) => {
        const [, d, t] = n.text.split(':')
        return { time: n.time, delta: parseInt(d), total: parseInt(t) }
      })
      .filter((n) => !isNaN(n.delta) && !isNaN(n.total))
      .sort((a, b) => a.time - b.time)
    if (existing.length > 0) setFishSnapshots(existing)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Snapshot fish count at every 5-second boundary and persist as video-note
  useEffect(() => {
    const bucket = Math.floor(currentTime / 5)
    if (lastBucketRef.current === -1) {
      lastBucketRef.current = bucket
      countAtBucketStartRef.current = fishCount
      return
    }
    if (bucket !== lastBucketRef.current) {
      const delta = fishCount - countAtBucketStartRef.current
      if (delta !== 0) {
        const snapTime = lastBucketRef.current * 5
        const snapFrame = Math.round(snapTime * fps)
        setFishSnapshots((prev) => {
          const existing = prev.findIndex((s) => s.time === snapTime)
          if (existing >= 0) {
            const next = [...prev]
            next[existing] = { time: snapTime, delta: prev[existing].delta + delta, total: fishCount }
            return next
          }
          return [...prev, { time: snapTime, delta, total: fishCount }]
        })
        onAddNote?.({ time: snapTime, frame: snapFrame, text: `__ft__:${delta}:${fishCount}` })
      }
      lastBucketRef.current = bucket
      countAtBucketStartRef.current = fishCount
    }
  }, [currentTime, fishCount])

  const seekToNote = (time: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = time
    setCurrentTime(time)
  }

  const formatTime = (time: number) => {
    const hrs = Math.floor(time / 3600)
    const mins = Math.floor((time % 3600) / 60)
    const secs = Math.floor(time % 60)
    if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const currentFrame = Math.round(currentTime * fps)
  const totalFrames = Math.round(duration * fps)
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

  const visibleNotes = notes.filter((n) => !n.text.startsWith('__ft__:'))
  const sortedNotes = [...visibleNotes].sort((a, b) => a.time - b.time)

  return (
    <div className="flex w-full h-full">
      {/* Video container */}
      <div
        ref={containerRef}
        className={cn(
          "relative flex flex-col h-full bg-black overflow-hidden group/player transition-all",
          showNotepad ? "flex-1 min-w-0 rounded-l-lg" : "w-full rounded-lg"
        )}
        onMouseMove={resetHideTimer}
        onMouseLeave={() => isPlaying && setShowControls(false)}
      >
        {/* Video */}
        <div className="flex-1 min-h-0 flex items-center justify-center cursor-pointer" onClick={togglePlay}>
          <video
            ref={videoRef}
            src={videoUrl ?? undefined}
            preload="auto"
            muted={isMuted}
            playsInline
            className="max-w-full max-h-full object-contain"
          />

          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-10 h-10 text-white/70 animate-spin" />
            </div>
          )}

          {showMidline && (
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{ top: '50%', height: '2px', background: 'rgba(234,179,8,0.7)' }}
            />
          )}

          {!isPlaying && !isLoading && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
                <Play className="w-7 h-7 text-white fill-white ml-1" />
              </div>
            </div>
          )}
        </div>

        {/* Expand button — top right of video */}
        {onExpand && (
          <button
            onClick={onExpand}
            className="absolute top-4 right-4 z-10 p-2 bg-black/60 hover:bg-black/80 backdrop-blur-sm border border-white/10 hover:border-white/20 text-white/70 hover:text-white rounded-lg shadow-lg transition-all hover:scale-105 cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
            title="Expand Viewport"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Expand</span>
          </button>
        )}

        {/* Fish Counter HUD — top left, always visible */}
        <div className="absolute top-4 left-4 flex flex-col gap-1.5 bg-black/60 backdrop-blur-sm rounded-xl px-4 py-2.5">
          <div className="flex items-center gap-3">
            {canWrite && (
              <button
                onClick={onDecrement}
                disabled={fishCount <= 0}
                className="w-8 h-8 flex flex-col items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Minus className="w-4 h-4" />
                <span className="text-[9px] text-white/30 mt-0.5">D</span>
              </button>
            )}
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold text-white tabular-nums">{fishCount}</span>
              <span className="text-xs text-white/50 uppercase tracking-wider font-medium">fish</span>
            </div>
            {canWrite && (
              <button
                onClick={onIncrement}
                className="w-8 h-8 flex flex-col items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span className="text-[9px] text-white/30 mt-0.5">F</span>
              </button>
            )}
            {duration > 0 && (
              <button
                onClick={() => setShowEscapement((v) => !v)}
                className="w-6 h-6 flex items-center justify-center rounded text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
                title={showEscapement ? 'Hide daily escapement' : 'Show daily escapement'}
              >
                {showEscapement ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
          {duration > 0 && showEscapement && (
            <div className="text-center border-t border-white/10 pt-1">
              <span className="text-[11px] text-white/40 uppercase tracking-wider font-medium">Daily est.</span>
              <span className="block text-sm font-bold text-white/80 tabular-nums">
                {fishCount > 0
                  ? Math.round(fishCount * (3600 / duration) * 24 * 2).toLocaleString()
                  : '—'}
              </span>
            </div>
          )}
        </div>

        {/* Bottom controls */}
        <div className={cn(
          "absolute bottom-0 left-0 right-0 transition-opacity duration-300",
          showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
        )}>
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pointer-events-none" />

          <div className="relative px-3 pb-3 pt-8">
            {/* Progress bar */}
            <div
              className="group/seek w-full h-1 hover:h-1.5 bg-white/20 rounded-full cursor-pointer mb-3 relative transition-all"
              onClick={handleSeek}
              onMouseMove={handleSeekHover}
              onMouseLeave={() => setHoverTime(null)}
            >
              {duration > 0 && bufferedRanges.map((range, idx) => (
                <div
                  key={idx}
                  className="absolute top-0 bottom-0 bg-white/20 rounded-full"
                  style={{ left: `${(range.start / duration) * 100}%`, width: `${((range.end - range.start) / duration) * 100}%` }}
                />
              ))}

              <div
                className="absolute top-0 bottom-0 left-0 bg-blue-500 rounded-full"
                style={{ width: `${progressPct}%` }}
              />

              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full opacity-0 group-hover/seek:opacity-100 transition-opacity shadow-sm"
                style={{ left: `${progressPct}%`, marginLeft: '-6px' }}
              />

              {/* Note markers on timeline */}
              {notes.map(note => {
                const notePct = duration > 0 ? (note.time / duration) * 100 : 0
                return (
                  <div
                    key={note.id}
                    className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 bg-yellow-400 rounded-full pointer-events-none"
                    style={{ left: `${notePct}%`, marginLeft: '-3px' }}
                  />
                )
              })}

              {hoverTime !== null && (
                <div
                  className="absolute -top-8 -translate-x-1/2 bg-black/80 text-white text-[11px] font-mono px-2 py-0.5 rounded pointer-events-none"
                  style={{ left: `${hoverX}px` }}
                >
                  {formatTime(hoverTime)}
                </div>
              )}
            </div>

            {/* Controls row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <button onClick={togglePlay} className="p-1.5 text-white hover:text-white/80 transition-colors">
                  {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
                </button>

                <button onClick={() => stepFrame('prev')} className="p-1.5 text-white/70 hover:text-white transition-colors" title="Previous frame">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button onClick={() => stepFrame('next')} className="p-1.5 text-white/70 hover:text-white transition-colors" title="Next frame">
                  <ChevronRight className="w-4 h-4" />
                </button>

                <span className="text-[12px] text-white/70 font-mono ml-2 select-none">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
              </div>

              <div className="flex items-center gap-1">
                <span className="text-[11px] text-white/40 font-mono mr-2 select-none">
                  Frame {currentFrame} / {totalFrames || '—'}
                </span>

                {/* Notepad toggle */}
                {canWrite && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setShowNotepad(p => !p)}
                      className={cn(
                        "p-1.5 transition-colors",
                        showNotepad ? "text-yellow-400 hover:text-yellow-300" : "text-white/70 hover:text-white"
                      )}
                      title="Notes (N)"
                    >
                      <NotebookPen className="w-4 h-4" />
                    </button>
                    {!showNotepad && (
                      <span className="text-[10px] text-white/30">press <kbd className="font-mono bg-white/10 rounded px-1">N</kbd> for notes</span>
                    )}
                  </div>
                )}

                {/* Settings */}
                <div className="relative">
                  <button
                    onClick={() => setShowSettings(!showSettings)}
                    className="p-1.5 text-white/70 hover:text-white transition-colors"
                    title="Settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>

                  {showSettings && (
                    <div className="absolute bottom-full right-0 mb-2 bg-black/90 backdrop-blur-sm rounded-lg border border-white/10 p-3 min-w-[180px] space-y-3 text-sm">
                      <div>
                        <label className="text-[10px] text-white/40 uppercase tracking-wider block mb-1">Speed</label>
                        <div className="flex flex-wrap gap-1">
                          {[0.25, 0.5, 1, 1.5, 2, 4].map(rate => (
                            <button
                              key={rate}
                              onClick={() => setPlaybackRate(rate)}
                              className={cn(
                                "px-2 py-0.5 rounded text-xs transition-colors",
                                playbackRate === rate ? "bg-white text-black font-semibold" : "text-white/60 hover:text-white hover:bg-white/10"
                              )}
                            >
                              {rate}x
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] text-white/40 uppercase tracking-wider block mb-1">Midline</label>
                        <button
                          onClick={() => setShowMidline(p => !p)}
                          className={cn(
                            "flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors w-full",
                            showMidline ? "bg-white text-black font-semibold" : "text-white/60 hover:text-white hover:bg-white/10"
                          )}
                        >
                          {showMidline ? 'On' : 'Off'}
                        </button>
                      </div>
                      <div>
                        <label className="text-[10px] text-white/40 uppercase tracking-wider block mb-1">Sound</label>
                        <button
                          onClick={toggleMute}
                          className={cn(
                            "flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors w-full",
                            isMuted ? "text-white/60 hover:text-white hover:bg-white/10" : "bg-white text-black font-semibold"
                          )}
                        >
                          {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                          {isMuted ? 'Muted' : 'On'}
                        </button>
                      </div>
                      <div>
                        <label className="text-[10px] text-white/40 uppercase tracking-wider block mb-1">Frame Rate</label>
                        <div className="flex flex-wrap gap-1 items-center">
                          {[24, 25, 30, 60].map(rate => (
                            <button
                              key={rate}
                              onClick={() => setFps(rate)}
                              className={cn(
                                "px-2 py-0.5 rounded text-xs transition-colors",
                                fps === rate ? "bg-white text-black font-semibold" : "text-white/60 hover:text-white hover:bg-white/10"
                              )}
                            >
                              {rate}
                            </button>
                          ))}
                          <button
                            onClick={() => setShowAdvancedFps(p => !p)}
                            className={cn(
                              "px-2 py-0.5 rounded text-[10px] transition-colors",
                              showAdvancedFps || fps === 23.976 || fps === 29.97
                                ? "text-white/80 bg-white/10"
                                : "text-white/30 hover:text-white/50"
                            )}
                          >
                            Advanced
                          </button>
                        </div>
                        {showAdvancedFps && (
                          <div className="flex flex-col gap-1 mt-2">
                            <button
                              onClick={() => setFps(23.976)}
                              className={cn(
                                "flex items-center justify-between px-2 py-1 rounded text-xs transition-colors",
                                fps === 23.976 ? "bg-white text-black font-semibold" : "text-white/60 hover:text-white hover:bg-white/10"
                              )}
                            >
                              <span>23.976</span>
                              <span className={cn("text-[10px]", fps === 23.976 ? "text-black/50" : "text-white/30")}>NTSC Film</span>
                            </button>
                            <button
                              onClick={() => setFps(29.97)}
                              className={cn(
                                "flex items-center justify-between px-2 py-1 rounded text-xs transition-colors",
                                fps === 29.97 ? "bg-white text-black font-semibold" : "text-white/60 hover:text-white hover:bg-white/10"
                              )}
                            >
                              <span>29.97</span>
                              <span className={cn("text-[10px]", fps === 29.97 ? "text-black/50" : "text-white/30")}>NTSC Broadcast</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Notepad panel */}
      {/* Fish timeline pop-out */}
      {fishTimelinePopped && !showNotepad && (
        <div className="absolute top-4 right-4 z-20 w-64 bg-gray-950/95 backdrop-blur-sm border border-gray-800 rounded-xl shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
            <div className="flex items-center gap-1.5">
              <History className="w-3.5 h-3.5 text-orange-400" />
              <span className="text-xs font-semibold text-white">Fish Timeline</span>
            </div>
            <button onClick={() => setFishTimelinePopped(false)} className="text-gray-500 hover:text-white transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {fishSnapshots.length === 0 ? (
            <p className="px-3 py-4 text-[10px] text-gray-600 text-center">No fish counted yet.</p>
          ) : (
            <div className="max-h-60 overflow-y-auto p-3 space-y-1">
              {fishSnapshots.map((s) => (
                <div
                  key={s.time}
                  className="flex items-center justify-between text-[10px] cursor-pointer hover:opacity-80"
                  onClick={() => seekToNote(s.time)}
                >
                  <span className="font-mono text-gray-400">{formatTime(s.time)}</span>
                  <span className={cn('font-bold', s.delta > 0 ? 'text-green-400' : 'text-red-400')}>
                    {s.delta > 0 ? `+${s.delta}` : s.delta}
                  </span>
                  <span className="text-gray-500">{s.total} counted</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showNotepad && (
        <div className="w-80 flex-shrink-0 bg-gray-950 border-l border-gray-800 flex flex-col rounded-r-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <NotebookPen className="w-4 h-4 text-yellow-400" />
              <span className="text-sm font-semibold text-white">Notes</span>
              {visibleNotes.length > 0 && (
                <span className="text-[10px] text-gray-500 bg-gray-800 rounded-full px-1.5 py-0.5">{visibleNotes.length}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowFishTimeline((v) => !v)}
                className={cn('flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-colors', showFishTimeline ? 'bg-gray-800 text-orange-400' : 'text-gray-500 hover:text-white')}
                title="Fish timeline"
              >
                <History className="w-3.5 h-3.5" />
                {fishSnapshots.length > 0 && <span>{fishSnapshots.length}</span>}
              </button>
              <button onClick={() => setShowNotepad(false)} className="text-gray-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Fish timeline */}
          {showFishTimeline && (
            <div className="border-b border-gray-800 bg-gray-900/60">
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-orange-400">Fish Timeline</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      notes.filter((n) => n.text.startsWith('__ft__:')).forEach((n) => onDeleteNote?.(n.id))
                      setFishSnapshots([])
                      lastBucketRef.current = -1
                      countAtBucketStartRef.current = 0
                    }}
                    className="text-[9px] text-gray-500 hover:text-red-400 transition-colors px-1.5 py-0.5 rounded hover:bg-gray-800"
                    title="Reset timeline"
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => setFishTimelinePopped((v) => !v)}
                    className="text-gray-600 hover:text-white transition-colors"
                    title="Pop out"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              </div>
              {fishSnapshots.length === 0 ? (
                <p className="px-4 pb-3 text-[10px] text-gray-600">No fish counted yet.</p>
              ) : (
                <div className="max-h-40 overflow-y-auto px-4 pb-3 space-y-1">
                  {fishSnapshots.map((s) => (
                    <div
                      key={s.time}
                      className="flex items-center justify-between text-[10px] cursor-pointer hover:opacity-80"
                      onClick={() => seekToNote(s.time)}
                    >
                      <span className="font-mono text-gray-400">{formatTime(s.time)}</span>
                      <span className={cn('font-bold', s.delta > 0 ? 'text-green-400' : 'text-red-400')}>
                        {s.delta > 0 ? `+${s.delta}` : s.delta}
                      </span>
                      <span className="text-gray-500">{s.total} counted</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Notes list */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {sortedNotes.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-600 text-xs">
                No notes yet. Add a note below to mark observations at the current timestamp.
              </div>
            ) : (
              <div className="divide-y divide-gray-800/50">
                {sortedNotes.map(note => (
                  <div
                    key={note.id}
                    className="group/note px-4 py-2.5 hover:bg-gray-900/50 transition-colors cursor-pointer"
                    onClick={() => seekToNote(note.time)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-mono text-blue-400">
                        {formatTime(note.time)} <span className="text-gray-600">[Frame {note.frame}]</span>
                      </span>
                      {canWrite && onDeleteNote && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDeleteNote(note.id) }}
                          className="opacity-0 group-hover/note:opacity-100 text-gray-600 hover:text-red-400 transition-all"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-gray-300 leading-relaxed">{note.text}</p>
                    {note.author && (
                      <p className="text-[10px] text-gray-600 mt-0.5">{note.author}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Input */}
          {canWrite && (
            <div className="border-t border-gray-800 p-3">
              <div className="flex items-center gap-1.5 mb-2 text-[10px] text-gray-500 font-mono">
                <span>{formatTime(currentTime)}</span>
                <span className="text-gray-700">[Frame {currentFrame}]</span>
              </div>
              <form
                onSubmit={(e) => { e.preventDefault(); handleAddNote() }}
                className="flex gap-2"
              >
                <input
                  ref={noteInputRef}
                  type="text"
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  placeholder="Add a note..."
                  className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
                <button
                  type="submit"
                  disabled={!noteInput.trim()}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
                >
                  Add
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
