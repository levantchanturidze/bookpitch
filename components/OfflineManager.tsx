import { useState, useEffect } from 'react';
import {
  Wifi,
  WifiOff,
  CloudLightning,
  RefreshCw,
  CheckCircle2,
  CloudUpload,
  Info,
} from 'lucide-react';
import { SyncQueueItem } from '@/lib/types';
import { motion, AnimatePresence } from 'motion/react';

interface OfflineManagerProps {
  isOnline: boolean;
  onToggleOnline: () => void;
  syncQueue: SyncQueueItem[];
  onTriggerSync: () => void;
}

export default function OfflineManager({
  isOnline,
  onToggleOnline,
  syncQueue,
  onTriggerSync,
}: OfflineManagerProps) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [showNotification, setShowNotification] = useState(false);
  const [notifMessage, setNotifMessage] = useState('');

  // Notify user when connection state changes
  useEffect(() => {
    setNotifMessage(
      isOnline
        ? 'Online mode activated. Cloud backup secured.'
        : 'Offline mode activated. Data will save to LocalStorage.',
    );
    setShowNotification(true);
    const timer = setTimeout(() => setShowNotification(false), 3500);
    return () => clearTimeout(timer);
  }, [isOnline]);

  const handleManualSync = () => {
    if (!isOnline) {
      alert('Cannot sync while offline! Please toggle Online state first.');
      return;
    }
    if (syncQueue.length === 0) {
      alert('Local storage queue is empty. No pending records to sync.');
      return;
    }

    setIsSyncing(true);
    setTimeout(() => {
      setIsSyncing(false);
      onTriggerSync();
      setNotifMessage('Sync Complete! All local records written to Cloud DB.');
      setShowNotification(true);
    }, 2000);
  };

  return (
    <div
      className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm"
      id="offline-manager-container"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className={`rounded-lg p-2 ${isOnline ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}
          >
            {isOnline ? (
              <Wifi className="h-4.5 w-4.5" />
            ) : (
              <WifiOff className="h-4.5 w-4.5 animate-pulse" />
            )}
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-800">Connectivity & Sync Engine</h3>
            <p className="text-[10px] text-slate-400">
              Manage data integrity and LocalStorage offline fallback
            </p>
          </div>
        </div>

        {/* Dynamic connection state pill */}
        <button
          onClick={onToggleOnline}
          className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold shadow-sm transition ${
            isOnline
              ? 'border-emerald-100 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              : 'border-amber-100 bg-amber-50 text-amber-700 hover:bg-amber-100'
          }`}
          id="toggle-connectivity-btn"
          title="Toggle network connectivity simulation"
        >
          {isOnline ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              Online / Synced
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-500"></span>
              Offline Mode
            </>
          )}
        </button>
      </div>

      {/* Sync queue metrics */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Left Col: Queue indicator */}
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/50 p-4">
          <div>
            <span className="block font-mono text-[10px] tracking-wider text-slate-400 uppercase">
              Pending Sync Queue
            </span>
            <h4 className="mt-1 font-mono text-base font-extrabold text-slate-800">
              {syncQueue.length} records
            </h4>
            <span className="mt-0.5 block font-sans text-[9px] text-slate-400">
              Saved locally via LocalStorage
            </span>
          </div>

          <button
            onClick={handleManualSync}
            disabled={isSyncing || syncQueue.length === 0}
            className="rounded-xl bg-slate-900 p-3 text-white shadow transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
            id="force-sync-btn"
            title="Push local data queue to cloud database"
          >
            <CloudUpload className={`h-5 w-5 ${isSyncing ? 'animate-bounce' : ''}`} />
          </button>
        </div>

        {/* Right Col: Sync Info */}
        <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/50 p-4">
          <Info className="h-5 w-5 shrink-0 text-slate-400" />
          <p className="text-[11px] leading-relaxed text-slate-500">
            {isOnline
              ? 'Our cloud sync service continuously backs up scheduler states. Disconnection automatically stores transaction queues inside LocalStorage to maintain uptime.'
              : 'All edits will save locally. When internet connection is recovered, your pending changes will be securely synchronized to our primary PostgreSQL/Firestore databases.'}
          </p>
        </div>
      </div>

      {/* Sync Queue Table / list */}
      {syncQueue.length > 0 && (
        <div className="rounded-xl border border-slate-100 p-3">
          <span className="mb-2 block font-mono text-[9px] font-bold tracking-wide text-slate-400 uppercase">
            Local Transaction Logs Queue
          </span>
          <div className="max-h-[120px] space-y-1.5 overflow-y-auto pr-1">
            {syncQueue.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 p-2 font-mono text-[10px]"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded px-1 text-[8px] font-bold uppercase ${
                      item.action === 'create'
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-blue-50 text-blue-600'
                    }`}
                  >
                    {item.action}
                  </span>
                  <span className="font-medium text-slate-700 capitalize">{item.entity}</span>
                </div>
                <span className="text-[9px] text-slate-400">{item.timestamp}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toast Alert Simulation */}
      <AnimatePresence>
        {showNotification && (
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
            className="fixed right-6 bottom-6 z-50 flex max-w-sm items-center gap-2.5 rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-xs text-white shadow-xl"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>{notifMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
