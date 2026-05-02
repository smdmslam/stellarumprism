// Utility functions - demonstrates missing export
function formatEmail(name: string, domain: string) {
  return `${name}@${domain}`;
}

// ❌ formatEmail is NOT exported but index.ts tries to import it

export function validateEmail(email: string) {
  return email.includes('@');
}

export function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
