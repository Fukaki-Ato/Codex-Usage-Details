import { useEffect, useRef, type ReactNode } from 'react'

export function AccountDialog({ busy, onClose, children }: { busy: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  const busyRef = useRef(busy)
  close.current = onClose
  busyRef.current = busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) close.current(); return }
      if (event.key !== 'Tab') return
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])]
      const first = elements[0], last = elements[elements.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="modal-backdrop" onClick={() => { if (!busy) onClose() }}>
    <section ref={dialog} tabIndex={-1} className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-modal-title" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head"><h2 id="account-modal-title">管理账户</h2><button aria-label="关闭" disabled={busy} onClick={onClose}>×</button></div>
      {children}
    </section>
  </div>
}
