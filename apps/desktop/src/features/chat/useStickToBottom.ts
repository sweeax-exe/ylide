import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Distance from the bottom (px) that still counts as "at the bottom". */
const SLACK = 32;

/**
 * Keeps a scroll container pinned to its end while its content grows, until
 * the user scrolls up. Returns whether it is pinned and a function to pin it
 * again (the "Jump to latest" button, or a new message).
 *
 * Only an upward scroll unpins: the scroll event of our own jump to the end
 * can arrive after more text was laid out, and must not count as the user
 * leaving the bottom.
 */
export function useStickToBottom(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>) {
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  const toEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, [scrollRef]);

  const pin = useCallback(() => {
    pinned.current = true;
    setAtBottom(true);
    toEnd();
  }, [toEnd]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const onScroll = () => {
      const top = el.scrollTop;
      if (el.scrollHeight - top - el.clientHeight <= SLACK) pinned.current = true;
      else if (top < lastTop.current - 1) pinned.current = false;
      lastTop.current = top;
      setAtBottom(pinned.current);
    };
    const follow = () => {
      if (pinned.current) toEnd();
    };
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    follow();
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, contentRef, toEnd]);

  return { atBottom, pin };
}
