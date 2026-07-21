import { useState, useEffect } from 'react';
import { Wifi, WifiOff, CloudLightning, RefreshCw, CheckCircle2, CloudUpload, Info } from 'lucide-react';
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
    setNotifMessage(isOnline ? 'Online mode activated. Cloud backup secured.' : 'Offline mode activated. Data will save to LocalStorage.');
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
    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm space-y-4" id="offline-manager-container">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`p-2 rounded-lg ${isOnline ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
            {isOnline ? <Wifi className="h-4.5 w-4.5" /> : <WifiOff className="h-4.5 w-4.5 animate-pulse" />}
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-800">Connectivity & Sync Engine</h3>
            <p className="text-[10px] text-slate-400">Manage data integrity and LocalStorage offline fallback</p>
          </div>
        </div>

        {/* Dynamic connection state pill */}
        <button
          onClick={onToggleOnline}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 border shadow-sm ${
            isOnline
              ? 'bg-emerald-50 text-emerald-700 border-emerald-100 hover:bg-emerald-100'
              : 'bg-amber-50 text-amber-700 border-amber-100 hover:bg-amber-100'
          }`}
          id="toggle-connectivity-btn"
          title="Toggle network connectivity simulation"
        >
          {isOnline ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              Online / Synced
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>
              Offline Mode
            </>
          )}
        </button>
      </div>

      {/* Sync queue metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left Col: Queue indicator */}
        <div className="border border-slate-100 bg-slate-50/50 p-4 rounded-xl flex items-center justify-between">
          <div>
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block">
              Pending Sync Queue
            </span>
            <h4 className="text-base font-extrabold text-slate-800 mt-1 font-mono">
              {syncQueue.length} records
            </h4>
            <span className="text-[9px] text-slate-400 mt-0.5 block font-sans">
              Saved locally via LocalStorage
            </span>
          </div>

          <button
            onClick={handleManualSync}
            disabled={isSyncing || syncQueue.length === 0}
            className="p-3 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl shadow transition"
            id="force-sync-btn"
            title="Push local data queue to cloud database"
          >
            <CloudUpload className={`h-5 w-5 ${isSyncing ? 'animate-bounce' : ''}`} />
          </button>
        </div>

        {/* Right Col: Sync Info */}
        <div className="border border-slate-100 bg-slate-50/50 p-4 rounded-xl flex items-center gap-3">
          <Info className="h-5 w-5 text-slate-400 shrink-0" />
          <p className="text-[11px] text-slate-500 leading-relaxed">
            {isOnline
              ? 'Our cloud sync service continuously backs up scheduler states. Disconnection automatically stores transaction queues inside LocalStorage to maintain uptime.'
              : 'All edits will save locally. When internet connection is recovered, your pending changes will be securely synchronized to our primary PostgreSQL/Firestore databases.'}
          </p>
        </div>
      </div>

      {/* Sync Queue Table / list */}
      {syncQueue.length > 0 && (
        <div className="border border-slate-100 rounded-xl p-3">
          <span className="text-[9px] font-mono font-bold text-slate-400 uppercase tracking-wide block mb-2">
            Local Transaction Logs Queue
          </span>
          <div className="max-h-[120px] overflow-y-auto space-y-1.5 pr-1">
            {syncQueue.map((item) => (
              <div key={item.id} className="flex justify-between items-center text-[10px] p-2 bg-slate-50 border border-slate-100 rounded-lg font-mono">
                <div className="flex items-center gap-1.5">
                  <span className={`px-1 rounded text-[8px] uppercase font-bold ${
                    item.action === 'create' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'
                  }`}>
                    {item.action}
                  </span>
                  <span className="text-slate-700 capitalize font-medium">{item.entity}</span>
                </div>
                <span className="text-slate-400 text-[9px]">{item.timestamp}</span>
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
            className="fixed bottom-6 right-6 bg-slate-900 border border-slate-800 text-white rounded-xl shadow-xl px-4 py-3 z-50 flex items-center gap-2.5 max-w-sm text-xs"
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            <span>{notifMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
