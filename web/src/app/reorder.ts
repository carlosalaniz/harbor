import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

// Drag to arrange, the way a phone's home screen does: press and move (mouse), or hold then move (touch),
// or use Arrange mode with the keyboard. Tiles glide into place (FLIP) and the final order is committed once.
export interface Reorder {
  order: string[];
  dragging: string | null;
  arranging: boolean;
  setArranging: (on: boolean) => void;
  tileProps: (id: string) => { ref: (el: HTMLElement | null) => void; onPointerDown: (e: ReactPointerEvent) => void; onKeyDown: (e: React.KeyboardEvent) => void; style: React.CSSProperties | undefined; 'data-dragging': boolean | undefined };
  suppressClick: (id: string) => boolean; // true right after a drag, so the tile's click does not open the app
}

const HOLD_MS = 320;
const MOVE_PX = 6;

export function useReorder(ids: string[], onCommit: (order: string[]) => void): Reorder {
  const [order, setOrder] = useState<string[]>(ids);
  const [dragging, setDragging] = useState<string | null>(null);
  const [arranging, setArranging] = useState(false);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const els = useRef(new Map<string, HTMLElement>());
  // grid slots (by index) measured when a drag starts; they do not move while the tile count is constant
  const slots = useRef<DOMRect[]>([]);
  const press = useRef<{ id: string; x: number; y: number; pointerId: number; touch: boolean; timer: number | null; active: boolean; moved: boolean } | null>(null);
  const justDragged = useRef<string | null>(null);
  // the live order, updated synchronously (pointer events can outrun React's render)
  const orderRef = useRef(order);
  const setOrderNow = (next: string[]) => {
    orderRef.current = next;
    setOrder(next);
  };

  // keep in sync with the server's order unless a drag is in progress
  const key = ids.join('|');
  useEffect(() => {
    if (!press.current?.active) setOrderNow(ids);
  }, [key]);

  // Slot rectangles: where each tile sits in the grid, ignoring the lift transform of the dragged one.
  const slotRect = (id: string, el: HTMLElement): DOMRect => {
    if (id !== (press.current?.active ? press.current.id : null)) return el.getBoundingClientRect();
    const t = el.style.transform;
    el.style.transform = 'none';
    const r = el.getBoundingClientRect();
    el.style.transform = t;
    return r;
  };

  // FLIP: before the browser paints a new order, move every tile from where it was to where it is now, then release.
  const prevRects = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    for (const [id, el] of els.current) next.set(id, slotRect(id, el));
    for (const [id, el] of els.current) {
      const a = prevRects.current.get(id);
      const b = next.get(id);
      if (!a || !b || id === dragging) continue;
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)';
        el.style.transform = '';
      });
    }
    prevRects.current = next;
  }, [order, dragging]);

  const measure = () => {
    slots.current = orderRef.current.map((id) => {
      const el = els.current.get(id);
      return el ? slotRect(id, el) : new DOMRect(0, 0, 0, 0);
    });
  };
  const stopTouchScroll = (e: TouchEvent) => e.preventDefault();

  const finish = useCallback(
    (commit: boolean) => {
      const p = press.current;
      if (!p) return;
      if (p.timer) window.clearTimeout(p.timer);
      document.removeEventListener('touchmove', stopTouchScroll);
      const el = els.current.get(p.id);
      if (p.active) {
        justDragged.current = p.id;
        window.setTimeout(() => (justDragged.current = null), 250);
        if (commit) onCommit(orderRef.current);
        el?.classList.remove('lifted');
      }
      press.current = null;
      setDragging(null);
      setOffset({ x: 0, y: 0 });
    },
    [onCommit],
  );

  const activate = () => {
    const p = press.current;
    if (!p || p.active) return;
    p.active = true;
    measure();
    setDragging(p.id);
    els.current.get(p.id)?.classList.add('lifted');
    document.addEventListener('touchmove', stopTouchScroll, { passive: false });
    if (navigator.vibrate) navigator.vibrate(10);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!p.active) {
        if (Math.hypot(dx, dy) > MOVE_PX) {
          p.moved = true;
          if (p.touch && !arranging) {
            // a finger that moves before the hold completes is scrolling, not arranging
            if (p.timer) window.clearTimeout(p.timer);
            press.current = null;
            return;
          }
          activate();
        } else return;
      }
      setOffset({ x: dx, y: dy });
      // which slot is the pointer over? move the dragged tile there (indices, not tiles: render timing does not matter)
      let to = -1;
      let bestD = Infinity;
      slots.current.forEach((r, i) => {
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (d < bestD) {
          bestD = d;
          to = i;
        }
      });
      const cur = orderRef.current;
      const from = cur.indexOf(p.id);
      if (to !== -1 && from !== -1 && to !== from && bestD < (slots.current[to]?.width ?? 100) * 0.75) {
        const next = cur.slice();
        next.splice(from, 1);
        next.splice(to, 0, p.id);
        // the dragged tile jumps to a new slot: re-base the press origin so it stays under the pointer
        const a = slots.current[from]!;
        const b = slots.current[to]!;
        p.x += b.left - a.left;
        p.y += b.top - a.top;
        setOffset({ x: e.clientX - p.x, y: e.clientY - p.y });
        setOrderNow(next);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (press.current && e.pointerId === press.current.pointerId) finish(true);
    };
    const onCancel = () => finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [arranging, finish]);

  useEffect(() => {
    if (!arranging) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setArranging(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arranging]);

  const moveBy = (id: string, delta: number) => {
    const cur = orderRef.current;
    const from = cur.indexOf(id);
    const to = Math.max(0, Math.min(cur.length - 1, from + delta));
    if (from === -1 || from === to) return;
    const next = cur.slice();
    next.splice(from, 1);
    next.splice(to, 0, id);
    setOrderNow(next);
    onCommit(next);
    requestAnimationFrame(() => els.current.get(id)?.querySelector<HTMLElement>('a,button')?.focus());
  };

  const tileProps: Reorder['tileProps'] = (id) => ({
    ref: (el) => {
      if (el) els.current.set(id, el);
      else els.current.delete(id);
    },
    onPointerDown: (e) => {
      if (e.button !== 0 || press.current) return;
      const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
      press.current = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch, timer: null, active: false, moved: false };
      if (touch && !arranging) {
        // hold to lift (and enter Arrange mode so the next drags are immediate)
        press.current.timer = window.setTimeout(() => {
          if (press.current && !press.current.moved) {
            setArranging(true);
            activate();
          }
        }, HOLD_MS);
      } else if (arranging) activate();
    },
    onKeyDown: (e) => {
      if (!arranging) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveBy(id, -1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveBy(id, 1);
      }
    },
    style: dragging === id ? { transform: `translate(${offset.x}px, ${offset.y}px) scale(1.08)`, zIndex: 5, transition: 'none' } : undefined,
    'data-dragging': dragging === id || undefined,
  });

  return { order, dragging, arranging, setArranging, tileProps, suppressClick: (id) => justDragged.current === id || (arranging && dragging === null && false) };
}
