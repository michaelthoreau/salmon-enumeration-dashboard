const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const ffmpegPath = require('ffmpeg-static')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 620,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })
  mainWindow.loadFile('index.html')
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv'])

function findVideos(dir) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findVideos(fullPath))
    } else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath)
    }
  }
  return results
}

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('scan-folder', async (_event, folderPath) => {
  const videos = findVideos(folderPath)
  return videos.map((v) => ({
    input: v,
    relativePath: path.relative(folderPath, v),
    size: fs.statSync(v).size,
    name: path.basename(v),
  }))
})

ipcMain.handle('check-duplicates', async (_event, { inputFolder, videos }) => {
  const folderName = path.basename(inputFolder)
  const parentDir = path.dirname(inputFolder)
  const outputFolder = path.join(parentDir, `${folderName} - Compressed`)

  const existing = videos.filter((v) => {
    const outputPath = path.join(outputFolder, v.relativePath)
    return fs.existsSync(outputPath)
  })

  return existing.map((v) => v.name)
})

ipcMain.handle('compress', async (event, { inputFolder, videos, settings, overwrite }) => {
  const folderName = path.basename(inputFolder)
  const parentDir = path.dirname(inputFolder)
  const outputFolder = path.join(parentDir, `${folderName} - Compressed`)

  let completed = 0

  for (const video of videos) {
    const outputPath = path.join(outputFolder, video.relativePath)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })

    if (fs.existsSync(outputPath) && !overwrite) {
      completed++
      event.sender.send('progress', {
        current: completed,
        total: videos.length,
        file: video.name,
        status: 'skipped',
      })
      continue
    }

    try {
      await compressVideo(video.input, outputPath, settings, (percent) => {
        event.sender.send('progress', {
          current: completed,
          total: videos.length,
          file: video.name,
          percent,
          status: 'compressing',
        })
      })
      completed++
      event.sender.send('progress', {
        current: completed,
        total: videos.length,
        file: video.name,
        status: 'done',
      })
    } catch (err) {
      completed++
      event.sender.send('progress', {
        current: completed,
        total: videos.length,
        file: video.name,
        status: 'error',
        error: err.message,
      })
    }
  }

  return { outputFolder, completed }
})

function buildArgs(input, output, settings) {
  const args = ['-i', input, '-map_metadata', '0', '-movflags', 'use_metadata_tags']

  const codec = settings.codec || 'h265'
  const encoder = settings.encoder || 'hardware'
  const quality = settings.quality ?? 22
  const preset = settings.preset || 'medium'
  const framerate = settings.framerate || 'auto'
  const resolution = settings.resolution || 'auto'
  const audioBitrate = settings.audioBitrate || '128k'

  // Video codec
  if (codec === 'h265') {
    if (encoder === 'hardware') {
      args.push('-c:v', 'hevc_videotoolbox', '-q:v', String(Math.round(quality * 2.7)))
    } else {
      args.push('-c:v', 'libx265', '-crf', String(quality), '-preset', preset)
    }
  } else if (codec === 'h264') {
    if (encoder === 'hardware') {
      args.push('-c:v', 'h264_videotoolbox', '-q:v', String(Math.round(quality * 2.7)))
    } else {
      args.push('-c:v', 'libx264', '-crf', String(quality), '-preset', preset)
    }
  }

  // Resolution
  if (resolution === '1080p') {
    args.push('-vf', 'scale=-2:1080')
  } else if (resolution === '720p') {
    args.push('-vf', 'scale=-2:720')
  } else if (resolution === '480p') {
    args.push('-vf', 'scale=-2:480')
  }

  // Frame rate
  if (framerate !== 'auto') {
    args.push('-r', framerate)
  }

  // Audio
  if (settings.audioCodec === 'none') {
    args.push('-an')
  } else {
    args.push('-c:a', 'aac', '-b:a', audioBitrate)
  }

  args.push('-y', output)
  return args
}

function compressVideo(input, output, settings, onProgress) {
  return new Promise((resolve, reject) => {
    const args = buildArgs(input, output, settings)
    const proc = spawn(ffmpegPath, args)
    let duration = 0
    let stderr = ''

    proc.stderr.on('data', (data) => {
      const str = data.toString()
      stderr += str

      const durMatch = str.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
      if (durMatch) {
        duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3])
      }

      const timeMatch = str.match(/time=(\d+):(\d+):(\d+)\.(\d+)/)
      if (timeMatch && duration > 0) {
        const current = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3])
        onProgress(Math.min(99, Math.round((current / duration) * 100)))
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        // Fallback: if hardware encoder failed, retry with software
        const usedHardware = args.includes('hevc_videotoolbox') || args.includes('h264_videotoolbox')
        if (usedHardware) {
          const fallbackSettings = { ...settings, encoder: 'software' }
          const fallbackArgs = buildArgs(input, output, fallbackSettings)
          const proc2 = spawn(ffmpegPath, fallbackArgs)
          proc2.stderr.on('data', (data) => {
            const str = data.toString()
            const timeMatch = str.match(/time=(\d+):(\d+):(\d+)\.(\d+)/)
            if (timeMatch && duration > 0) {
              const current = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3])
              onProgress(Math.min(99, Math.round((current / duration) * 100)))
            }
          })
          proc2.on('close', (code2) => {
            if (code2 === 0) resolve()
            else reject(new Error(`FFmpeg exited with code ${code2}`))
          })
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`))
        }
      }
    })
  })
}
