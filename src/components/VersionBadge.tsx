import { useState } from 'react';
import { APP_VERSION, forceUpdateApp, formatBuildTime } from '../appVersion';
import './VersionBadge.css';

/**
 * Shows which build is actually running and offers a way out when the service
 * worker keeps serving an old one. Both matter when a fix appears not to have
 * landed: the version tells you whether you are even running it.
 */
export function VersionBadge() {
  const [updating, setUpdating] = useState(false);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await forceUpdateApp();
    } catch {
      // The reload is the point; if tearing down the caches fails, reload anyway.
      window.location.reload();
    }
  };

  return (
    <div className="version-badge" title={`Built ${formatBuildTime()}`}>
      <span className="version-badge-text">v{APP_VERSION}</span>
      <button
        type="button"
        className="version-badge-update"
        onClick={handleUpdate}
        disabled={updating}
        title="Discard the cached app and reload the latest version"
      >
        {updating ? 'Updating…' : 'Update'}
      </button>
    </div>
  );
}
