# PRISM Demo Project for Screenshots

This project contains intentional bugs designed to showcase PRISM's verification capabilities.

## Planted Scenarios

### 1. Incomplete Refactor (THE wedge)
- **File:** `src/api.ts`
- **Bug:** Imports `getUser` but function was renamed to `fetchUserById` in `src/auth.ts`
- **PRISM Detection:** `typecheck` + `ast_query` → `✓ Observed`

### 2. Missing Export
- **File:** `src/utils.ts`
- **Bug:** `formatEmail` is not exported but `src/index.ts` imports it
- **PRISM Detection:** `typecheck` → "Module has no exported member"

### 3. Type Mismatch
- **File:** `src/users.ts`
- **Bug:** `createUser` accepts `id: string` but `User` interface expects `id: number`
- **PRISM Detection:** `typecheck` → Type error

### 4. Unused Imports (LSP)
- **File:** `src/routes/handler.ts`
- **Bug:** Imports `unused` and `alsoUnused` but never uses them
- **PRISM Detection:** `lsp_diagnostics` → Unused variable warnings

### 5. Failing Test
- **File:** `tests/auth.test.ts`
- **Bug:** Test expects 'Alice' but function returns 'Demo User'
- **PRISM Detection:** `run_tests` → Test failure

## How to Use

1. Install dependencies:
   ```bash
   cd .prism/projects/prism-demo-shots
   npm install
   ```

2. Run PRISM commands:
   ```bash
   prism /audit
   prism /build
   ```

3. Capture screenshots of:
   - The Problems panel showing findings
   - The agent panel showing tool evidence
   - The confidence labels (`✓ Observed`, `~ Inferred`, `? Candidate`)
