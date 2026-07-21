'use client'
import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

// Modal/dialog fókusz-csapda: kezdő fókusz a (tabIndex={-1}) konténerre,
// Tab/Shift+Tab ciklikusan a konténeren belül marad, Escape zár, záráskor
// a fókusz visszakerül a megnyitó elemre. Az onClose-t egy ref tartja
// frissen, hogy a keydown-listener ne igényeljen effect-újrafutást minden
// szülő-rerendernél (elkerülve, hogy egy köztes rerender újra elkapja a
// document.activeElement-et, ami akkor már a modalon belüli elem lenne).
export function useFocusTrap(onClose: () => void) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    containerRef.current?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current(); return }
      if (e.key !== 'Tab') return
      const container = containerRef.current
      if (!container) return
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(el => !el.hasAttribute('disabled'))
      if (focusable.length === 0) { e.preventDefault(); container.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement
      const focusIsOutside = !container.contains(activeElement)

      if (e.shiftKey && (activeElement === container || activeElement === first || focusIsOutside)) {
        e.preventDefault(); last.focus(); return
      }
      if (!e.shiftKey && (activeElement === container || activeElement === last || focusIsOutside)) {
        e.preventDefault(); first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  return containerRef
}
