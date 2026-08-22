/**
 * Renders the real accessibility primitives to static HTML so a Playwright spec
 * can mount them in a real browser with the real stylesheet.
 *
 * This runs as a separate process on purpose. Playwright's test transform wraps
 * React elements in its own component-testing objects (`__pw_type`), so calling
 * React.createElement inside a spec produces "Objects are not valid as a React
 * child". Rendering here and handing the spec plain HTML sidesteps that without
 * weakening what is being tested: the markup is still produced by the actual
 * components.
 *
 * Output: JSON on stdout, { [name]: html }.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import ModalShell from '../components/ui/ModalShell';
import Field from '../components/ui/Field';
import StatusMessage from '../components/ui/StatusMessage';
import {
  DetailEmpty,
  DetailError,
  DetailLoading,
  ListEmpty,
} from '../components/patients/DetailStates';

const fixtures: Record<string, string> = {
  dialog: renderToStaticMarkup(
    <ModalShell titleId="dlg" panelClassName="w-full max-w-md">
      <h2 id="dlg" className="mb-1 text-base font-bold text-slate-800">
        Edit member
      </h2>
      <p className="mb-4 text-xs text-slate-500">Change the role for this member.</p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600"
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white"
        >
          Save
        </button>
      </div>
    </ModalShell>,
  ),

  validationError: renderToStaticMarkup(
    <div className="space-y-4 p-6">
      <Field
        label="Email"
        required
        hint="We only use this for sign-in."
        error="Enter a valid email address"
      >
        {(p) => (
          <input
            {...p}
            type="email"
            name="email"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
          />
        )}
      </Field>
      <StatusMessage tone="error">Could not save your changes.</StatusMessage>
    </div>,
  ),

  statuses: renderToStaticMarkup(
    <div className="space-y-3 p-6">
      <StatusMessage tone="success">Member updated.</StatusMessage>
      <StatusMessage tone="warning">This location has no staff.</StatusMessage>
      <StatusMessage tone="info">Changes apply from tomorrow.</StatusMessage>
      <StatusMessage tone="error">Could not update member.</StatusMessage>
    </div>,
  ),

  fieldValid: renderToStaticMarkup(
    <div className="space-y-4 p-6">
      <Field label="Organisation name" required hint="Shown to your customers.">
        {(p) => (
          <input
            {...p}
            name="orgName"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
          />
        )}
      </Field>
    </div>,
  ),
  // F16-008 — the states a per-selection fetch introduces. Rendered here so the
  // Playwright spec checks the real markup in six real browsers, including at
  // 320px where the retry button and the message have to coexist.
  patientsDetailLoading: renderToStaticMarkup(
    <div className="flex h-64 flex-col rounded-xl border border-slate-200 bg-white p-6">
      <DetailLoading label="patient" />
    </div>,
  ),
  patientsDetailError: renderToStaticMarkup(
    <div className="flex h-64 flex-col rounded-xl border border-slate-200 bg-white p-6">
      <DetailError message="Could not load this record." />
    </div>,
  ),
  patientsDetailEmpty: renderToStaticMarkup(
    <div className="flex h-64 flex-col rounded-xl border border-slate-200 bg-white p-6">
      <DetailEmpty label="patient" />
    </div>,
  ),
  patientsListEmpty: renderToStaticMarkup(
    <div className="flex h-64 flex-col rounded-xl border border-slate-200 bg-white p-5">
      <ListEmpty searching label="patients" />
    </div>,
  ),
};

process.stdout.write(JSON.stringify(fixtures));
