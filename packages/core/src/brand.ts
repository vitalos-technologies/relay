// Product brand (single source of truth for user-facing naming). Internal identifiers
// (package scope @social-lite/*, database names, cookie names, realm ids) are unchanged.
export const BRAND = {
  name: 'Relay',
  tagline: 'Create. Coordinate. Publish.',
  defaultEmailFrom: 'Relay <no-reply@relay.invalid>',
  colors: {
    red: '#FE4114',
    orange: '#FD6701',
    amber: '#FDA602',
    ink: '#121416',
    mist: '#EBEDEE',
    gradientFrom: '#FD8221',
    gradientTo: '#F13E1F',
  },
} as const;
