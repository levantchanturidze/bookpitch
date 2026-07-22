// -----------------------------------------------------------------------------
// Template variable rendering. Preserves the prototype's placeholder syntax:
//   {PatientName}, {StaffName}, {ServiceName}, {Date}, {Time}
// Missing variables render as '—' so nothing scary ends up in the send body.
// -----------------------------------------------------------------------------

export type TemplateVars = {
  PatientName?: string | null;
  StaffName?: string | null;
  ServiceName?: string | null;
  Date?: string | null;
  Time?: string | null;
};

export const PLACEHOLDER_KEYS = [
  'PatientName',
  'StaffName',
  'ServiceName',
  'Date',
  'Time',
] as const satisfies readonly (keyof TemplateVars)[];

export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(/\{(\w+)\}/g, (match, key: string) => {
    if ((PLACEHOLDER_KEYS as readonly string[]).includes(key)) {
      const value = vars[key as keyof TemplateVars];
      return value == null || value === '' ? '—' : String(value);
    }
    // Unknown placeholder: leave verbatim so template authors notice.
    return match;
  });
}

// Reasonable defaults used when an org hasn't customised anything yet.
export const DEFAULT_SMS_TEMPLATE =
  'Reminder from Bookpitch: {PatientName}, your {ServiceName} with {StaffName} is on {Date} at {Time}. Reply STOP to opt out.';

export const DEFAULT_EMAIL_TEMPLATE =
  'Hi {PatientName},\n\nThis is a friendly reminder of your upcoming {ServiceName} with {StaffName} on {Date} at {Time}.\n\nSee you then!\nBookpitch';

export const DEFAULT_EMAIL_SUBJECT = 'Reminder: {ServiceName} on {Date}';
