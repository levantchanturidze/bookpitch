import { redirect } from 'next/navigation';

// Middleware ensures we're authenticated by the time we reach this page.
// Default landing is the scheduler; the (app) route group renders the shell.
export default function Root() {
  redirect('/scheduler');
}
