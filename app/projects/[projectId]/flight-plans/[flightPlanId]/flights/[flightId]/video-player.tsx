'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, ChevronLeft, ChevronRight, Volume2, VolumeX, Loader2, Minus, Plus, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

interface VideoPlayerProps {
  videoUrl: string
  filename: string
  fishCount?: number
  canWrite?: boolean
  onIncrement?: () => void
  onDecrement?: () => void
}

export default function VideoPlayer({ videoUrl, filename, fishCount = 0, canWrite = false, onIncrement, onDecrement }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoUrl) return

    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleTimeUpdate = () => setCurrentTime(video.currentTime)
    const handleDurationChange = () => setDuration(video.duration)
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

  // Auto-hide controls during playback
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

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  // Hotkeys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
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

  const toggleFullscreen = () => {
    if (!containerRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current.requestFullscreen()
    }
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

  return (
    <div
      ref={containerRef}
      className="relative flex flex-col w-full h-full bg-black rounded-lg overflow-hidden group/player"
      onMouseMove={resetHideTimer}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* Video */}
      <div className="flex-1 min-h-0 flex items-center justify-center cursor-pointer" onClick={togglePlay}>
        <video
          ref={videoRef}
          src={videoUrl}
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

        {/* Big play button when paused */}
        {!isPlaying && !isLoading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
              <Play className="w-7 h-7 text-white fill-white ml-1" />
            </div>
          </div>
        )}
      </div>

      {/* Fish Counter HUD — top right overlay, always visible */}
      <div className="absolute top-4 right-4 flex items-center gap-3 bg-black/60 backdrop-blur-sm rounded-xl px-4 py-2.5">
        {canWrite && (
          <button
            onClick={onDecrement}
            disabled={fishCount <= 0}
            className="w-8 h-8 flex flex-col items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Decrement (D)"
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
            title="Increment (F)"
          >
            <Plus className="w-4 h-4" />
            <span className="text-[9px] text-white/30 mt-0.5">F</span>
          </button>
        )}
      </div>

      {/* Bottom controls — YouTube-style gradient overlay */}
      <div className={cn(
        "absolute bottom-0 left-0 right-0 transition-opacity duration-300",
        showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
      )}>
        {/* Gradient */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pointer-events-none" />

        <div className="relative px-3 pb-3 pt-8">
          {/* Progress bar */}
          <div
            className="group/seek w-full h-1 hover:h-1.5 bg-white/20 rounded-full cursor-pointer mb-3 relative transition-all"
            onClick={handleSeek}
            onMouseMove={handleSeekHover}
            onMouseLeave={() => setHoverTime(null)}
          >
            {/* Buffered */}
            {duration > 0 && bufferedRanges.map((range, idx) => (
              <div
                key={idx}
                className="absolute top-0 bottom-0 bg-white/20 rounded-full"
                style={{ left: `${(range.start / duration) * 100}%`, width: `${((range.end - range.start) / duration) * 100}%` }}
              />
            ))}

            {/* Progress */}
            <div
              className="absolute top-0 bottom-0 left-0 bg-blue-500 rounded-full"
              style={{ width: `${progressPct}%` }}
            />

            {/* Scrub dot */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full opacity-0 group-hover/seek:opacity-100 transition-opacity shadow-sm"
              style={{ left: `${progressPct}%`, marginLeft: '-6px' }}
            />

            {/* Hover tooltip */}
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
            {/* Left controls */}
            <div className="flex items-center gap-1">
              <button onClick={togglePlay} className="p-1.5 text-white hover:text-white/80 transition-colors">
                {isPlaying
                  ? <Pause className="w-5 h-5 fill-current" />
                  : <Play className="w-5 h-5 fill-current" />
                }
              </button>

              <button onClick={() => stepFrame('prev')} className="p-1.5 text-white/70 hover:text-white transition-colors" title="Previous frame (←)">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => stepFrame('next')} className="p-1.5 text-white/70 hover:text-white transition-colors" title="Next frame (→)">
                <ChevronRight className="w-4 h-4" />
              </button>

              <span className="text-[12px] text-white/70 font-mono ml-2 select-none">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-white/40 font-mono mr-2 select-none">
                Frame {currentFrame} / {totalFrames || '—'}
              </span>

              {/* Settings popover */}
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
                              playbackRate === rate
                                ? "bg-white text-black font-semibold"
                                : "text-white/60 hover:text-white hover:bg-white/10"
                            )}
                          >
                            {rate}x
                          </button>
                        ))}
                      </div>
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
                      <div className="flex flex-wrap gap-1">
                        {[23.976, 24, 25, 29.97, 30, 60].map(rate => (
                          <button
                            key={rate}
                            onClick={() => setFps(rate)}
                            className={cn(
                              "px-2 py-0.5 rounded text-xs transition-colors",
                              fps === rate
                                ? "bg-white text-black font-semibold"
                                : "text-white/60 hover:text-white hover:bg-white/10"
                            )}
                          >
                            {rate === 23.976 ? '23.98' : rate}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
