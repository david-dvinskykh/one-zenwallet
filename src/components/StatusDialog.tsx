import { useEffect } from 'react';
import './StatusDialog.css';

export interface WriteStatus {
  /** What was being written, e.g. "Save reminder". */
  label: string;
  state: 'saving' | 'ok' | 'error';
  /** The server's own explanation, shown verbatim on failure. */
  detail?: string;
}

const TITLES: Record<WriteStatus['state'], (label: string) => string> = {
  saving: (label) => `${label}…`,
  ok: (label) => `${label} — saved to ZenMoney`,
  error: (label) => `${label} — failed`,
};

const ICONS: Record<WriteStatus['state'], string> = {
  saving: '⏳',
  ok: '✅',
  error: '⚠️',
};

/**
 * Reports the outcome of a write that goes straight to ZenMoney. These pushes
 * do not run through the "Save Data" button, so without this a rejected entity
 * would leave nothing on screen at all.
 */
export function StatusDialog({
  status,
  onClose,
  autoCloseMs = 1600,
}: {
  status: WriteStatus | null;
  onClose: () => void;
  /** Successful writes dismiss themselves; failures stay until closed. */
  autoCloseMs?: number;
}) {
  const state = status?.state;

  useEffect(() => {
    if (state !== 'ok') return;
    const timer = setTimeout(onClose, autoCloseMs);
    return () => clearTimeout(timer);
  }, [state, autoCloseMs, onClose]);

  useEffect(() => {
    if (!status || status.state === 'saving') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status, onClose]);

  if (!status) return null;

  const dismissible = status.state !== 'saving';

  return (
    <div
      className="status-dialog-backdrop"
      onClick={() => dismissible && onClose()}
      role="presentation"
    >
      <div
        className={`status-dialog ${status.state}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={TITLES[status.state](status.label)}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="status-dialog-title">
          <span aria-hidden="true">{ICONS[status.state]}</span>
          {TITLES[status.state](status.label)}
        </p>

        {status.detail && <pre className="status-dialog-detail">{status.detail}</pre>}

        {status.state === 'error' && (
          <p className="status-dialog-hint">
            Nothing was changed in ZenMoney. The message above comes from the ZenMoney API.
          </p>
        )}

        {dismissible && (
          <div className="status-dialog-actions">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
