import { redirect } from 'next/navigation';

// /settings alias — bounce to the first tab so the sidebar item works
// without needing multiple entries.
export default function SettingsIndex() {
  redirect('/settings/locations');
}
