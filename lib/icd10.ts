// -----------------------------------------------------------------------------
// Curated starter set of ICD-10 codes for a general-practice clinic in
// Georgia. Not the full WHO catalogue — that lives at
// icd.who.int/browse10 — but enough to cover common encounters. Operators
// can pick any code; the description is a suggestion, not an override.
//
// Codes chosen for: high-frequency GP visits + chronic conditions +
// dermatology/aesthetic overlap. Extend freely; keep entries alphabetised
// by code so diffs are stable.
// -----------------------------------------------------------------------------

export type Icd10 = {
  code: string;
  description: string;
  category: 'infection' | 'chronic' | 'derm' | 'msk' | 'mental' | 'preventive' | 'other';
};

export const ICD10_CATALOG: Icd10[] = [
  { code: 'A09',   description: 'Infectious gastroenteritis', category: 'infection' },
  { code: 'B02.9', description: 'Zoster without complication', category: 'infection' },
  { code: 'E11.9', description: 'Type 2 diabetes mellitus without complications', category: 'chronic' },
  { code: 'E78.5', description: 'Hyperlipidaemia, unspecified', category: 'chronic' },
  { code: 'F32.9', description: 'Depressive episode, unspecified', category: 'mental' },
  { code: 'F41.1', description: 'Generalised anxiety disorder', category: 'mental' },
  { code: 'G43.9', description: 'Migraine, unspecified', category: 'other' },
  { code: 'H10.9', description: 'Conjunctivitis, unspecified', category: 'infection' },
  { code: 'I10',   description: 'Essential (primary) hypertension', category: 'chronic' },
  { code: 'J00',   description: 'Acute nasopharyngitis (common cold)', category: 'infection' },
  { code: 'J02.9', description: 'Acute pharyngitis, unspecified', category: 'infection' },
  { code: 'J06.9', description: 'Acute upper respiratory infection, unspecified', category: 'infection' },
  { code: 'J20.9', description: 'Acute bronchitis, unspecified', category: 'infection' },
  { code: 'J45.9', description: 'Asthma, unspecified', category: 'chronic' },
  { code: 'K21.9', description: 'GERD without oesophagitis', category: 'chronic' },
  { code: 'K52.9', description: 'Noninfective gastroenteritis, unspecified', category: 'other' },
  { code: 'L20.9', description: 'Atopic dermatitis, unspecified', category: 'derm' },
  { code: 'L23.9', description: 'Allergic contact dermatitis, cause unspecified', category: 'derm' },
  { code: 'L70.0', description: 'Acne vulgaris', category: 'derm' },
  { code: 'L81.4', description: 'Melanin hyperpigmentation, other', category: 'derm' },
  { code: 'M25.5', description: 'Pain in joint', category: 'msk' },
  { code: 'M54.5', description: 'Low back pain', category: 'msk' },
  { code: 'M79.1', description: 'Myalgia', category: 'msk' },
  { code: 'N30.0', description: 'Acute cystitis', category: 'infection' },
  { code: 'N39.0', description: 'Urinary tract infection, site not specified', category: 'infection' },
  { code: 'R05',   description: 'Cough', category: 'other' },
  { code: 'R07.4', description: 'Chest pain, unspecified', category: 'other' },
  { code: 'R10.4', description: 'Other and unspecified abdominal pain', category: 'other' },
  { code: 'R51',   description: 'Headache', category: 'other' },
  { code: 'Z00.0', description: 'General adult medical examination', category: 'preventive' },
  { code: 'Z01.0', description: 'Examination of eyes and vision', category: 'preventive' },
  { code: 'Z13.9', description: 'Special screening examination, unspecified', category: 'preventive' },
];

const BY_CODE = new Map(ICD10_CATALOG.map((r) => [r.code.toUpperCase(), r]));

export function findIcd10(code: string): Icd10 | null {
  return BY_CODE.get(code.trim().toUpperCase()) ?? null;
}

// Loose validator — accepts anything in the "letter + 2-3 digits [ . digit(s) ]"
// shape ICD-10 uses. Doesn't require presence in the starter catalog because
// operators need the freedom to enter codes we haven't curated.
const ICD10_SHAPE = /^[A-Z]\d{2}(\.\d{1,3})?$/i;
export function isValidIcd10(code: string): boolean {
  return ICD10_SHAPE.test(code.trim());
}
