import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

// Drag to arrange, the way a phone's home screen does: press and move (mouse), or hold then move (touch),
// or use Arrange mode with the keyboard. Tiles glide into place (FLIP) and the final order is committed once.
// Tiles live in groups (Home: the main grid and one per space, decision 210). Inside its own group a tile moves
// live; over another group that group lights up as the drop target, and the drop hands the move to `onMove`.
export interface ReorderGroup {
  key: string;
  ids: string[];
}

// A tile dropped on another group: `order` is the whole launcher order with the tile already in its new place.
export interface GroupMove {
  id: string;
  from: string;
  to: string;
  order: string[];
}

export interface Reorder {
  orderOf: (group: string) => string[];
  dragging: string | null;
  dropTarget: string | null;
  arranging: boolean;
  setArranging: (on: boolean) => void;
  groupRef: (group: string) => (el: HTMLElement | null) => void;
  tileProps: (id: string) => { ref: (el: HTMLElement | null) => void; onPointerDown: (e: ReactPointerEvent) => void; onKeyDown: (e: React.KeyboardEvent) => void; style: React.CSSProperties | undefined; 'data-dragging': boolean | undefined };
  suppressClick: (id: string) => boolean; // true right after a drag, so the tile's click does not open the app
}

const HOLD_MS = 320;
const MOVE_PX = 6;
const GROUP_SLACK_PX = 12; // a group's drop area reaches a little past its edges
const EDGE_PX = 64; // a drag this close to the top or bottom of the window scrolls the page
const EDGE_SPEED = 14; // px per frame at the very edge

// Rectangles in page coordinates, so a drag survives the page scrolling under it (a space below the fold).
const pageRect = (r: DOMRect) => new DOMRect(r.left + window.scrollX, r.top + window.scrollY, r.width, r.height);

type Groups = Record<string, string[]>;
const toGroups = (gs: ReorderGroup[]): Groups => Object.fromEntries(gs.map((g) => [g.key, g.ids.slice()]));

export function useReorder(groups: ReorderGroup[], onCommit: (order: string[]) => void, onMove?: (move: GroupMove) => void): Reorder {
  const keys = groups.map((g) => g.key);
  const props = toGroups(groups);
  const propsRef = useRef(props);
  propsRef.current = props;
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const flat = (g: Groups) => keysRef.current.flatMap((k) => g[k] ?? []);

  const [local, setLocal] = useState<Groups>(props);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTargetState] = useState<string | null>(null);
  const [arranging, setArranging] = useState(false);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const els = useRef(new Map<string, HTMLElement>());
  const groupEls = useRef(new Map<string, HTMLElement>());
  // measured when a drag starts: the slots of the dragged tile's own group (they do not move while its tile count is
  // constant), every other group's tiles (for the insertion point) and every group's area
  const slots = useRef<DOMRect[]>([]);
  const otherSlots = useRef(new Map<string, DOMRect[]>());
  const groupRects = useRef(new Map<string, DOMRect>());
  const press = useRef<{ id: string; group: string; x: number; y: number; pointerId: number; touch: boolean; timer: number | null; active: boolean; moved: boolean } | null>(null);
  const drop = useRef<{ group: string; index: number } | null>(null);
  const pointer = useRef({ x: 0, y: 0 }); // the last pointer position, in the window
  const justDragged = useRef<string | null>(null);
  // the live order during a drag, updated synchronously (pointer events can outrun React's render)
  const orderRef = useRef<Groups>(props);
  const setOrderNow = (next: Groups) => {
    orderRef.current = next;
    setLocal(next);
  };
  const setDropTarget = (t: { group: string; index: number } | null) => {
    drop.current = t;
    setDropTargetState(t?.group ?? null);
  };
  // Outside a drag the order is the caller's (every commit updates it in the same event), so nothing goes stale.
  const shown = dragging ? local : props;
  const groupOf = (g: Groups, id: string) => Object.keys(g).find((k) => g[k]!.includes(id)) ?? null;

  // Slot rectangles: where each tile sits in the grid, ignoring the lift transform of the dragged one.
  const slotRect = (id: string, el: HTMLElement): DOMRect => {
    if (id !== (press.current?.active ? press.current.id : null)) return pageRect(el.getBoundingClientRect());
    const t = el.style.transform;
    el.style.transform = 'none';
    const r = el.getBoundingClientRect();
    el.style.transform = t;
    return pageRect(r);
  };

  // FLIP: before the browser paints a new order, move every tile from where it was to where it is now, then release.
  const prevRects = useRef(new Map<string, DOMRect>());
  const shownKey = keys.map((k) => `${k}:${(shown[k] ?? []).join(',')}`).join('|');
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
  }, [shownKey, dragging]);

  const rectsOf = (ids: string[]) =>
    ids.map((id) => {
      const el = els.current.get(id);
      return el ? slotRect(id, el) : new DOMRect(0, 0, 0, 0);
    });
  const measure = (group: string) => {
    slots.current = rectsOf(orderRef.current[group] ?? []);
    otherSlots.current = new Map(Object.entries(orderRef.current).filter(([k]) => k !== group).map(([k, ids]) => [k, rectsOf(ids)]));
    groupRects.current = new Map([...groupEls.current].map(([k, el]) => [k, pageRect(el.getBoundingClientRect())]));
  };
  const stopTouchScroll = (e: TouchEvent) => e.preventDefault();

  const finish = useCallback(
    (commit: boolean) => {
      const p = press.current;
      if (!p) return;
      if (p.timer) window.clearTimeout(p.timer);
      document.removeEventListener('touchmove', stopTouchScroll);
      const target = drop.current;
      if (p.active) {
        justDragged.current = p.id;
        window.setTimeout(() => (justDragged.current = null), 250);
        if (commit && target && onMove) {
          const next = { ...orderRef.current, [p.group]: propsRef.current[p.group]!.filter((x) => x !== p.id) };
          const into = (propsRef.current[target.group] ?? []).filter((x) => x !== p.id);
          into.splice(Math.min(target.index, into.length), 0, p.id);
          next[target.group] = into;
          onMove({ id: p.id, from: p.group, to: target.group, order: flat(next) });
        } else if (commit) onCommit(flat(orderRef.current));
      }
      press.current = null;
      setDropTarget(null);
      setDragging(null);
      setOffset({ x: 0, y: 0 });
    },
    [onCommit, onMove],
  );

  const activate = () => {
    const p = press.current;
    if (!p || p.active) return;
    p.active = true;
    setOrderNow(toGroups(keysRef.current.map((k) => ({ key: k, ids: propsRef.current[k] ?? [] }))));
    measure(p.group);
    setDragging(p.id);
    document.addEventListener('touchmove', stopTouchScroll, { passive: false });
    if (navigator.vibrate) navigator.vibrate(10);
  };

  // Which other group is the pointer over, and where in it would the tile land? null: its own group (or none).
  const overOther = (p: { group: string }, x: number, y: number): { group: string; index: number } | null => {
    if (!onMove) return null;
    for (const [k, r] of groupRects.current) {
      if (x < r.left - GROUP_SLACK_PX || x > r.right + GROUP_SLACK_PX || y < r.top - GROUP_SLACK_PX || y > r.bottom + GROUP_SLACK_PX) continue;
      if (k === p.group) return null;
      const rs = otherSlots.current.get(k) ?? [];
      let index = rs.length;
      let bestD = Infinity;
      rs.forEach((s, i) => {
        const d = Math.hypot(x - (s.left + s.width / 2), y - (s.top + s.height / 2));
        if (d < bestD) {
          bestD = d;
          index = x > s.left + s.width / 2 ? i + 1 : i;
        }
      });
      return { group: k, index };
    }
    return null;
  };

  useEffect(() => {
    // Where the pointer is, in page coordinates: on a move, on a scroll under a still pointer, on an edge scroll.
    const update = () => {
      const p = press.current;
      if (!p?.active) return;
      const x = pointer.current.x + window.scrollX;
      const y = pointer.current.y + window.scrollY;
      setOffset({ x: x - p.x, y: y - p.y });
      const other = overOther(p, x, y);
      if (other) {
        if (drop.current?.group !== other.group || drop.current.index !== other.index) setDropTarget(other);
        return;
      }
      if (drop.current) setDropTarget(null);
      // which slot of its own group is the pointer over? move the dragged tile there (indices, not tiles: render timing does not matter)
      let to = -1;
      let bestD = Infinity;
      slots.current.forEach((r, i) => {
        const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (d < bestD) {
          bestD = d;
          to = i;
        }
      });
      const cur = orderRef.current[p.group] ?? [];
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
        setOffset({ x: x - p.x, y: y - p.y });
        setOrderNow({ ...orderRef.current, [p.group]: next });
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      pointer.current = { x: e.clientX, y: e.clientY };
      if (!p.active) {
        if (Math.hypot(e.clientX + window.scrollX - p.x, e.clientY + window.scrollY - p.y) > MOVE_PX) {
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
      update();
    };
    const onScroll = () => update();
    window.addEventListener('scroll', onScroll, { passive: true });
    const onUp = (e: PointerEvent) => {
      if (press.current && e.pointerId === press.current.pointerId) finish(true);
    };
    const onCancel = () => finish(false);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [arranging, finish]);

  // lifting a tile changes the layout around it (an empty group opens a drop area): measure again once that is painted
  useLayoutEffect(() => {
    if (dragging && press.current?.active) measure(press.current.group);
  }, [dragging]);

  // while a tile is lifted, near the top or bottom edge the page scrolls itself, faster the closer the pointer is
  // (never past the page's own end: the lifted tile follows the pointer and would otherwise stretch the page forever)
  useEffect(() => {
    if (!dragging) return;
    const end = document.documentElement.scrollHeight - window.innerHeight;
    let frame = 0;
    const edgeScroll = () => {
      frame = requestAnimationFrame(edgeScroll);
      const y = pointer.current.y;
      const dy = y < EDGE_PX ? -EDGE_SPEED * (1 - y / EDGE_PX) : y > window.innerHeight - EDGE_PX ? EDGE_SPEED * (1 - (window.innerHeight - y) / EDGE_PX) : 0;
      if (dy < 0 || (dy > 0 && window.scrollY < end)) window.scrollBy(0, Math.round(dy) || Math.sign(dy));
    };
    frame = requestAnimationFrame(edgeScroll);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  useEffect(() => {
    if (!arranging) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setArranging(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arranging]);

  const moveBy = (id: string, delta: number) => {
    const g = groupOf(propsRef.current, id);
    if (g === null) return;
    const cur = propsRef.current[g]!;
    const from = cur.indexOf(id);
    const to = Math.max(0, Math.min(cur.length - 1, from + delta));
    if (from === -1 || from === to) return;
    const next = cur.slice();
    next.splice(from, 1);
    next.splice(to, 0, id);
    onCommit(flat({ ...propsRef.current, [g]: next }));
    requestAnimationFrame(() => els.current.get(id)?.querySelector<HTMLElement>('a,button')?.focus());
  };

  const tileProps: Reorder['tileProps'] = (id) => ({
    ref: (el) => {
      if (el) els.current.set(id, el);
      else els.current.delete(id);
    },
    onPointerDown: (e) => {
      if (e.button !== 0 || press.current) return;
      const group = groupOf(propsRef.current, id);
      if (group === null) return;
      const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
      press.current = { id, group, x: e.clientX + window.scrollX, y: e.clientY + window.scrollY, pointerId: e.pointerId, touch, timer: null, active: false, moved: false };
      pointer.current = { x: e.clientX, y: e.clientY };
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

  const groupRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const groupRef = (group: string) => {
    let fn = groupRefs.current.get(group);
    if (!fn) {
      fn = (el) => {
        if (el) groupEls.current.set(group, el);
        else groupEls.current.delete(group);
      };
      groupRefs.current.set(group, fn);
    }
    return fn;
  };

  return {
    orderOf: (group) => shown[group] ?? [],
    dragging,
    dropTarget,
    arranging,
    setArranging,
    groupRef,
    tileProps,
    suppressClick: (id) => justDragged.current === id,
  };
}
