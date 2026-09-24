function editableFocus(): boolean {
  const focused = document.activeElement
  return focused instanceof HTMLElement && (focused.isContentEditable ||
    focused.closest('input, textarea, select, button, a, [contenteditable], [role="button"], [role="textbox"]') !== null)
}

function hasSelection(): boolean { return document.getSelection()?.isCollapsed === false }

/** 在当前图片的原生滚动容器上安装 Space + 鼠标左键拖动。 */
export function installImagePan(scrollport: HTMLElement, imageFrame: HTMLElement, options: {
  readonly active: () => boolean
  readonly signal: AbortSignal
}): () => void {
  let space = false
  let hovering = false
  let pointer: number | undefined
  let lastX = 0
  let lastY = 0
  let suppressClick = false
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  let pendingPointer: number | undefined
  const isCurrent = (): boolean => !options.signal.aborted && scrollport.isConnected &&
    scrollport.contains(imageFrame) && options.active()
  const overflowing = (): boolean => scrollport.scrollWidth > scrollport.clientWidth + 1 ||
    scrollport.scrollHeight > scrollport.clientHeight + 1
  const available = (): boolean => space && isCurrent() && overflowing() && !editableFocus() && !hasSelection()
  const cursor = (): void => {
    if (pointer !== undefined) scrollport.dataset.filesImagePan = 'dragging'
    else if (available()) scrollport.dataset.filesImagePan = 'ready'
    else delete scrollport.dataset.filesImagePan
  }
  const clearClick = (): void => {
    if (clickTimer !== undefined) clearTimeout(clickTimer)
    clickTimer = undefined
    pendingPointer = undefined
    window.removeEventListener('pointerup', onPendingUp, true)
    window.removeEventListener('pointercancel', onPendingCancel, true)
    suppressClick = false
  }
  const onClick = (event: MouseEvent): void => {
    if (!suppressClick) return
    event.preventDefault()
    event.stopImmediatePropagation()
    clearClick()
  }
  const onPendingUp = (event: PointerEvent): void => {
    if (event.pointerId !== pendingPointer) return
    pendingPointer = undefined
    window.removeEventListener('pointerup', onPendingUp, true)
    window.removeEventListener('pointercancel', onPendingCancel, true)
    clickTimer = setTimeout(clearClick, 0)
  }
  const onPendingCancel = (event: PointerEvent): void => { if (event.pointerId === pendingPointer) clearClick() }
  const end = (waitForRelease = false): void => {
    const id = pointer
    pointer = undefined
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    if (id !== undefined && scrollport.hasPointerCapture?.(id)) scrollport.releasePointerCapture(id)
    if (suppressClick && id !== undefined) {
      // 松开 Space 可能先于鼠标松开；保留一次 click 拦截直到该指针结束。
      if (waitForRelease) {
        pendingPointer = id
        window.addEventListener('pointerup', onPendingUp, true)
        window.addEventListener('pointercancel', onPendingCancel, true)
      } else clickTimer = setTimeout(clearClick, 0)
    }
    cursor()
  }
  const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) return
    if (!available() || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || (event.buttons & 1) === 0) { end(true); return }
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    if (dx === 0 && dy === 0) return
    event.preventDefault()
    scrollport.scrollLeft -= dx
    scrollport.scrollTop -= dy
    suppressClick = true
  }
  const onUp = (event: PointerEvent): void => { if (event.pointerId === pointer) end() }
  const onCancel = (event: PointerEvent): void => { if (event.pointerId === pointer) { clearClick(); end() } }
  const onDown = (event: PointerEvent): void => {
    if (pointer !== undefined || event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !available()) return
    const target = event.target
    if (!(target instanceof Element) || !imageFrame.contains(target) ||
      target.closest('button, a, input, textarea, select, [contenteditable], [role="button"]') !== null) return
    clearClick()
    pointer = event.pointerId
    lastX = event.clientX
    lastY = event.clientY
    event.preventDefault()
    scrollport.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    cursor()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (space && event.code !== 'Space' && (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)) {
      space = false
      end(true)
    }
    if (event.code !== 'Space' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
      editableFocus() || hasSelection()) return
    space = true
    if (hovering && available()) event.preventDefault()
    cursor()
  }
  const onEnter = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') return
    hovering = true
    cursor()
  }
  const onLeave = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') return
    hovering = false
    cursor()
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space') return
    space = false
    end(true)
  }
  const onBlur = (): void => { space = false; clearClick(); end() }
  const onLostCapture = (): void => { if (pointer !== undefined) end() }
  const onResize = (): void => { if (pointer !== undefined && !overflowing()) end(); else cursor() }
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onResize)
  resize?.observe(scrollport)
  resize?.observe(imageFrame)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  scrollport.addEventListener('pointerdown', onDown)
  scrollport.addEventListener('pointerenter', onEnter)
  scrollport.addEventListener('pointerleave', onLeave)
  scrollport.addEventListener('lostpointercapture', onLostCapture)
  scrollport.addEventListener('click', onClick, true)
  options.signal.addEventListener('abort', onBlur, { once: true })
  return () => {
    onBlur()
    resize?.disconnect()
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('blur', onBlur)
    scrollport.removeEventListener('pointerdown', onDown)
    scrollport.removeEventListener('pointerenter', onEnter)
    scrollport.removeEventListener('pointerleave', onLeave)
    scrollport.removeEventListener('lostpointercapture', onLostCapture)
    scrollport.removeEventListener('click', onClick, true)
    options.signal.removeEventListener('abort', onBlur)
  }
}
