'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Share2, Check, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export default function ShareFlightButton() {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <Button 
        variant="outline" 
        size="sm" 
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5"
      >
        <Share2 className="w-3.5 h-3.5" />
        <span>Share</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share flight</DialogTitle>
            <DialogDescription>
              Copy the link below to share this flight's view and enumeration data.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center space-x-2 pt-2">
            <div className="grid flex-1 gap-2">
              <Input
                readOnly
                defaultValue={typeof window !== 'undefined' ? window.location.href : ''}
                className="font-mono text-xs select-all bg-gray-50 border-gray-200"
              />
            </div>
            <Button 
              type="button" 
              size="sm" 
              onClick={handleCopy}
              className={cn("flex-shrink-0 transition-all duration-200", copied && "bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600")}
              variant={copied ? 'default' : 'outline'}
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 mr-1" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  Copy
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
