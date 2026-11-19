'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

// Right-hand panel with Escape-to-close and focus moved inside while open.
export function Drawer({ title, description, open, onClose, children, footer }: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="wc-overlay" onClick={onClose} aria-hidden="true" />
      <div ref={panel} className="wc-drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="wc-drawer-title">{title}</h2>
            {description ? <p className="wc-muted mt-1 text-[13px] leading-[22px]">{description}</p> : null}
          </div>
          <button className="wc-btn wc-btn-quiet wc-icon-btn" onClick={onClose} aria-label={`Close ${title}`}>
            <X size={18} />
          </button>
        </div>
        <div className="wc-drawer-body">{children}</div>
        {footer ? <div className="border-t border-border pt-5">{footer}</div> : null}
      </div>
    </>
  );
}
