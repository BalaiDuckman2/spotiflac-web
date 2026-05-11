import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * Spotify-like Back/Forward bar.
 *
 * React Router doesn't expose a "can go forward" flag, so we track it manually:
 *  - Every navigation we observe via useLocation() that we DIDN'T trigger via
 *    our own Back/Forward buttons clears the forward stack.
 *  - Clicking Back pushes the current path onto the forward stack.
 *  - Clicking Forward pops from the forward stack.
 *
 * `back` is always enabled if window.history.length > 1, which matches the
 * browser's own behavior (and Spotify's).
 */
export default function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();

  const [forwardStack, setForwardStack] = useState<string[]>([]);
  const lastKnownPath = useRef<string>(location.pathname + location.search);
  // True for one render cycle after we trigger Back/Forward ourselves, so the
  // next useEffect doesn't treat that navigation as a fresh user action.
  const programmatic = useRef(false);

  useEffect(() => {
    const here = location.pathname + location.search;
    if (here === lastKnownPath.current) return;
    if (!programmatic.current) {
      // Fresh navigation (clicked a link, etc.) — clear forward stack.
      setForwardStack([]);
    }
    programmatic.current = false;
    lastKnownPath.current = here;
  }, [location]);

  const canBack = window.history.length > 1;
  const canForward = forwardStack.length > 0;

  const onBack = () => {
    if (!canBack) return;
    setForwardStack((s) => [...s, lastKnownPath.current]);
    programmatic.current = true;
    navigate(-1);
  };

  const onForward = () => {
    if (!canForward) return;
    setForwardStack((s) => s.slice(0, -1));
    programmatic.current = true;
    navigate(1);
  };

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-200 bg-white/80 px-6 py-2 backdrop-blur">
      <button
        onClick={onBack}
        disabled={!canBack}
        title="Précédent"
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 text-white transition',
          'hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400',
        )}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        onClick={onForward}
        disabled={!canForward}
        title="Suivant"
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 text-white transition',
          'hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400',
        )}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
