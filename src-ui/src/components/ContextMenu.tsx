import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import "./ContextMenu.css"

export type ContextMenuEntry =
  | { type: "separator" }
  | {
      type?: "item"
      label: string
      onSelect?: () => void
      disabled?: boolean
      danger?: boolean
      checked?: boolean
      submenu?: ContextMenuEntry[]
      hint?: string
    }

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuEntry[]
}

/** Opens a right-click context menu at the cursor with the given items.
 * `open` is meant to be spread onto an element's `onContextMenu` handler:
 * `onContextMenu={(e) => open(e, buildItems())}` - building the item list
 * lazily inside the handler (rather than a static prop) so it always
 * reflects current state at the moment of the click. */
export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState | null>(null)

  const open = useCallback((e: React.MouseEvent, items: ContextMenuEntry[]) => {
    e.preventDefault()
    e.stopPropagation()
    setState({ x: e.clientX, y: e.clientY, items })
  }, [])

  const close = useCallback(() => setState(null), [])

  return { menu: state, open, close }
}

interface ContextMenuProps {
  menu: ContextMenuState | null
  onClose: () => void
}

/** Renders the currently-open context menu (if any). A single instance of
 * this, placed once near the root of whichever view uses it, serves every
 * right-click target in that view - `useContextMenu` above tracks which
 * items are showing. */
export function ContextMenu({ menu, onClose }: ContextMenuProps) {
  useEffect(() => {
    if (!menu) return
    // A right-click's pointerdown/click on a menu item still bubbles to
    // this document-level listener - closing unconditionally on any
    // pointerdown would unmount the menu (and its button) before the
    // subsequent "click" event could ever fire on it, so every item
    // silently did nothing. Every menu panel (top-level and every nested
    // submenu) shares the "context-menu" class, so `closest` catches a
    // click anywhere inside any of them, however deep.
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest(".context-menu")) return
      onClose()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    const handleScroll = () => onClose()
    // Capture phase + a microtask delay: the same right-click that opened
    // this menu also fires a "contextmenu"-adjacent pointerdown/mousedown
    // on some platforms, which would otherwise close the menu in the same
    // tick it opened.
    const id = window.setTimeout(() => {
      document.addEventListener("pointerdown", handlePointerDown)
      document.addEventListener("keydown", handleKeyDown)
      window.addEventListener("scroll", handleScroll, true)
      window.addEventListener("blur", onClose)
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("scroll", handleScroll, true)
      window.removeEventListener("blur", onClose)
    }
  }, [menu, onClose])

  if (!menu) return null

  return (
    <MenuLevel
      items={menu.items}
      x={menu.x}
      y={menu.y}
      depth={0}
      onSelect={(fn) => {
        fn?.()
        onClose()
      }}
    />
  )
}

interface MenuLevelProps {
  items: ContextMenuEntry[]
  x: number
  y: number
  depth: number
  onSelect: (fn: (() => void) | undefined) => void
}

/** One menu panel (the top-level menu, or one open submenu). Submenus
 * render as a nested `MenuLevel` positioned relative to the hovered item,
 * recursing for however many levels are actually configured. */
function MenuLevel({ items, x, y, depth, onSelect }: MenuLevelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null)
  const itemRefs = useRef(new Map<number, HTMLButtonElement>())

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    let nextX = x
    let nextY = y
    if (rect.right > window.innerWidth - margin) {
      nextX = Math.max(margin, x - rect.width)
    }
    if (rect.bottom > window.innerHeight - margin) {
      nextY = Math.max(margin, window.innerHeight - margin - rect.height)
    }
    setPos({ x: nextX, y: nextY })
    // Deliberately re-measures only against the raw click point (x, y),
    // not the previous clamped `pos` - re-including `pos` here would make
    // this effect re-fire on its own output and fight itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, items])

  return (
    <div
      className="context-menu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry, i) => {
        if (entry.type === "separator") {
          return <div key={i} className="context-menu-separator" />
        }
        const hasSubmenu = !!entry.submenu && entry.submenu.length > 0
        const submenuOpen = openSubmenuIndex === i
        return (
          <div
            key={i}
            className="context-menu-item-wrap"
            onMouseEnter={() => hasSubmenu && setOpenSubmenuIndex(i)}
            onMouseLeave={() => hasSubmenu && setOpenSubmenuIndex((cur) => (cur === i ? null : cur))}
          >
            <button
              ref={(el) => {
                if (el) itemRefs.current.set(i, el)
                else itemRefs.current.delete(i)
              }}
              className={`context-menu-item ${entry.danger ? "danger" : ""} ${entry.checked ? "checked" : ""}`}
              disabled={entry.disabled}
              onClick={() => {
                if (hasSubmenu) return
                onSelect(entry.onSelect)
              }}
            >
              {entry.checked && <span className="context-menu-check">✓</span>}
              <span className="context-menu-label">{entry.label}</span>
              {entry.hint && <span className="context-menu-hint">{entry.hint}</span>}
              {hasSubmenu && <span className="context-menu-arrow">▸</span>}
            </button>
            {hasSubmenu && submenuOpen && (
              <MenuLevel
                items={entry.submenu as ContextMenuEntry[]}
                x={(itemRefs.current.get(i)?.getBoundingClientRect().right ?? pos.x) - 2}
                y={itemRefs.current.get(i)?.getBoundingClientRect().top ?? pos.y}
                depth={depth + 1}
                onSelect={onSelect}
              />
            )}
          </div>
        )
      })}
      {items.length === 0 && <div className="context-menu-empty">Nothing available</div>}
    </div>
  )
}
