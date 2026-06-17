'use client'

import { useEffect, useRef, useState } from 'react'
import { Play, Pause, ChevronLeft, ChevronRight, Volume2, VolumeX, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface VideoPlayerProps {
  videoUrl: string
  filename: string
}

export default function VideoPlayer({ videoUrl, filename }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isMuted, setIsMuted] = useState(true)
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [fps, setFps] = useState(29.97) // Default standard drone FPS, can be adjusted
  const [playbackRate, setPlaybackRate] = useState(1)

  // Sync state with video element
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

    const handleProgress = () => {
      const ranges: { start: number; end: number }[] = []
      for (let i = 0; i < video.buffered.length; i++) {
        ranges.push({
          start: video.buffered.start(i),
          end: video.buffered.end(i),
        })
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

    // Trigger initial load
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
    }
  }, [videoUrl])

  // Keep playback rate in sync when changed
  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.playbackRate = playbackRate
    }
  }, [playbackRate])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (isPlaying) {
      video.pause()
    } else {
      video.play().catch((err) => console.error('Failed to play video:', err))
    }
  }

  const toggleMute = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !isMuted
    setIsMuted(!isMuted)
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current
    if (!video) return
    const time = parseFloat(e.target.value)
    video.currentTime = time
    setCurrentTime(time)
  }

  // Frame-by-frame navigation
  const stepFrame = (direction: 'prev' | 'next') => {
    const video = videoRef.current
    if (!video) return
    video.pause() // Pause if playing

    const frameTime = 1 / fps
    let targetTime = video.currentTime + (direction === 'next' ? frameTime : -frameTime)
    
    // Clamp target time
    if (targetTime < 0) targetTime = 0
    if (targetTime > duration) targetTime = duration

    video.currentTime = targetTime
    setCurrentTime(targetTime)
  }

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60)
    const secs = Math.floor(time % 60)
    const ms = Math.floor((time % 1) * 100)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`
  }

  const currentFrame = Math.round(currentTime * fps)
  const totalFrames = Math.round(duration * fps)

  return (
    <div className="flex flex-col w-full h-full bg-slate-950 rounded-lg overflow-hidden border border-slate-800 shadow-2xl">
      {/* Video Viewport */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center bg-black group">
        <video
          ref={videoRef}
          src={videoUrl}
          preload="auto"
          muted={isMuted}
          playsInline
          className="max-w-full max-h-full object-contain"
          onClick={togglePlay}
        />

        {/* Loading Spinner Overlay */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-xs">
            <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
          </div>
        )}
      </div>

      {/* Custom Controls Panel */}
      <div className="bg-slate-900 border-t border-slate-800 px-4 py-3 space-y-3 select-none">
        
        {/* Time Bar & Buffer Indicator */}
        <div className="space-y-1">
          <div className="relative w-full h-2 bg-slate-800 rounded-full overflow-hidden group/slider">
            {/* Buffer Ranges */}
            {duration > 0 && bufferedRanges.map((range, idx) => {
              const left = (range.start / duration) * 100
              const width = ((range.end - range.start) / duration) * 100
              return (
                <div
                  key={idx}
                  className="absolute top-0 bottom-0 bg-slate-700/50 rounded-full transition-all"
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              )
            })}

            {/* Active Progress Fill */}
            <div
              className="absolute top-0 bottom-0 left-0 bg-blue-500 pointer-events-none"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />

            {/* Invisible Input Slider for Seeking */}
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.01}
              value={currentTime}
              onChange={handleSeek}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>

          {/* Time & Frame Labels */}
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 px-0.5">
            <div className="flex items-center gap-2">
              <span className="text-slate-200 font-semibold">{formatTime(currentTime)}</span>
              <span className="text-slate-600">/</span>
              <span>{formatTime(duration)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span>Frame: <strong className="text-slate-200">{currentFrame}</strong> / {totalFrames || '—'}</span>
              <span className="text-slate-600">|</span>
              <select
                value={fps}
                onChange={(e) => setFps(parseFloat(e.target.value))}
                className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-300 focus:outline-none"
              >
                <option value={23.976}>23.98 fps</option>
                <option value={24}>24 fps</option>
                <option value={25}>25 fps</option>
                <option value={29.97}>29.97 fps</option>
                <option value={30}>30 fps</option>
                <option value={50}>50 fps</option>
                <option value={59.94}>59.94 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </div>
          </div>
        </div>

        {/* Control Buttons */}
        <div className="flex items-center justify-between">
          {/* Left: Playback & Frame Steps */}
          <div className="flex items-center gap-2">
            <button
              onClick={togglePlay}
              className="p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors shadow-md"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
            </button>

            <div className="h-4 w-px bg-slate-800 mx-1" />

            <button
              onClick={() => stepFrame('prev')}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors border border-slate-700"
              title="Previous Frame"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <button
              onClick={() => stepFrame('next')}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors border border-slate-700"
              title="Next Frame"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-[10px] text-slate-500 font-medium hidden sm:inline">Frame-by-Frame</span>
          </div>

          {/* Right: Volume & Mute */}
          <div className="flex items-center gap-2">
            {/* Playback Speed Selector */}
            <div className="flex items-center gap-1.5 mr-2">
              <span className="text-[10px] text-slate-500 font-medium">Speed:</span>
              <select
                value={playbackRate}
                onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
                className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] font-medium text-slate-200 focus:outline-none cursor-pointer hover:bg-slate-750 transition-colors"
              >
                <option value={0.25}>0.25x</option>
                <option value={0.5}>0.5x</option>
                <option value={1}>1.0x (Normal)</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x</option>
                <option value={2}>2.0x</option>
                <option value={4}>4.0x</option>
              </select>
            </div>

            <button
              onClick={toggleMute}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors border border-slate-700"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
